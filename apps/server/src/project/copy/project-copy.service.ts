import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  API_ERROR_CODES,
  COPY_WARNING_CODES,
  type C3Revalidation,
  type CopyItemResult,
  type CopyPreviewItem,
  type CopyPreviewResponse,
  type ProjectCreateResponse,
  type StdEntityType,
  type ValidationIssue,
} from '@termflow/shared';
import type { Audit } from '../../common/audit/audit.js';
import {
  ConflictProblem,
  ProblemException,
  ValidationProblem,
} from '../../common/problem/problem.exception.js';
import { insertAudited, updateAudited } from '../../db/audit.js';
import type { Db } from '../../db/client.js';
import { DRIZZLE } from '../../db/db.module.js';
import { projectCopyLog, tfProject, tfProjectMember, tfUser } from '../../db/schema.js';
import { writeStdAudit } from '../../standard/std-audit.js';
import { revalidateC3, type C3Result } from './c3-revalidator.js';
import {
  ENTITY_ITEM_KEY,
  ENTITY_ORDER,
  needsC3,
  representativeSource,
  sameSource,
  type CopyItemKey,
  type CopyPlan,
  type CopySource,
} from './copy-plan.js';

/**
 * 복사 엔진(설계서 §4.4 `ProjectCopyService`, CR-01 C1~C7, T5.2). 프로젝트 생성·템플릿 게시·승계 COPY_TO_RMS가
 * 같은 구현을 쓴다. 한 트랜잭션(repeatable read — 여러 문장이 원본을 같은 스냅샷으로 읽는다)에서
 *   1 프로젝트·멤버 → 2 업무구분 → 3 도메인분류 → 4 용어 → 5 도메인 → 6 코드구분 → 7 코드 → 8 기본컬럼 세트·구성
 *   → 9 C3 재검증 → 10 project_copy_log 8행 + std_audit_log 항목별 COPY 요약
 * 을 서버측 `INSERT … SELECT`로 처리한다. ID 재매핑은 임시 테이블 없이 출처 컬럼(origin_id)과 자연키(suffix, biz_cd)로 한다.
 * 어느 단계든 실패하면 전부 롤백되고, 오류에 실패 단계(`step`)를 싣는다(부분 생성 없음).
 */
export type CopyStep =
  | 'PROJECT'
  | 'BIZ_AREA'
  | 'DOMAIN_CLS'
  | 'TERM'
  | 'DOMAIN'
  | 'CODE_CLS'
  | 'CODE'
  | 'DEFAULT_COL_SET'
  | 'DEFAULT_COL'
  | 'C3'
  | 'LOG';

/** 복사 실패(500) — 원인은 로그에만, 응답에는 실패 단계만. */
export class CopyFailedProblem extends ProblemException {
  constructor(
    readonly step: CopyStep,
    /** 원래 오류(로그용, 응답에는 싣지 않는다). */
    readonly origin: unknown,
  ) {
    super('internal', 500, 'E_COPY_FAILED', `${API_ERROR_CODES.E_COPY_FAILED}(단계: ${step})`, {
      step,
    });
  }
}

type Q = Pick<Db, 'execute' | 'select' | 'insert' | 'update'>;

interface ItemCount {
  sourceCnt: number;
  toCopy: number;
  warnings: ValidationIssue[];
}

const n = (v: unknown): number => Number(v ?? 0);
const textArray = (v: readonly string[]) => sql`${sql.param([...v])}::text[]`;

async function scalar(q: Q, query: SQL): Promise<number> {
  const { rows } = await q.execute(query);
  return n((rows[0] as { n?: unknown } | undefined)?.n);
}

/** 업무구분 원본에서 실제로 가져올 biz_cd(= 새 프로젝트의 업무구분 집합). */
async function targetBizCds(q: Q, plan: CopyPlan): Promise<string[]> {
  const s = plan.sources.bizAreas;
  if (s.projectId === null) return [];
  const { rows } = await q.execute(
    sql`select biz_cd from prj_biz_area where project_id = ${s.projectId}
          and (${plan.bizCds === null}::boolean or biz_cd = any(${textArray(plan.bizCds ?? [])}))
        order by sort_no, biz_cd`,
  );
  return (rows as { biz_cd: string }[]).map((r) => r.biz_cd);
}

/**
 * 항목별 원본 건수·복사 예정 건수(미리보기와 실제 복사가 같은 조건을 쓴다 — T5.4 "미리보기 건수 = 실제 복사 건수").
 */
export async function countPlan(
  q: Q,
  plan: CopyPlan,
): Promise<{ counts: Record<StdEntityType, ItemCount>; bizCds: string[] }> {
  const s = plan.sources;
  const bizCds = await targetBizCds(q, plan);
  const empty = (): ItemCount => ({ sourceCnt: 0, toCopy: 0, warnings: [] });
  const counts = Object.fromEntries(ENTITY_ORDER.map((e) => [e, empty()])) as Record<
    StdEntityType,
    ItemCount
  >;
  const simple = async (e: StdEntityType, table: SQL, src: CopySource) => {
    if (src.projectId === null) return;
    const c = await scalar(
      q,
      sql`select count(*)::int n from ${table} where project_id = ${src.projectId}`,
    );
    counts[e] = { sourceCnt: c, toCopy: c, warnings: [] };
  };
  if (s.bizAreas.projectId !== null) {
    counts.BIZ_AREA = {
      sourceCnt: await scalar(
        q,
        sql`select count(*)::int n from prj_biz_area where project_id = ${s.bizAreas.projectId}`,
      ),
      toCopy: bizCds.length,
      warnings: [],
    };
  }
  await simple('DOMAIN_CLS', sql`std_domain_cls`, s.domainClasses);
  if (s.terms.projectId !== null) {
    const { rows } = await q.execute(
      sql`select count(*)::int n, count(*) filter (where status = 'APPROVED')::int a
            from std_term where project_id = ${s.terms.projectId}`,
    );
    const r = rows[0] as { n: number; a: number };
    counts.TERM = { sourceCnt: n(r.n), toCopy: plan.approvedOnly ? n(r.a) : n(r.n), warnings: [] };
  }
  await simple('DOMAIN', sql`std_domain`, s.domains);
  if (s.codes.projectId !== null) {
    const { rows } = await q.execute(
      sql`select count(*)::int cls, count(*) filter (where b.biz_cd = any(${textArray(bizCds)}))::int cls_in,
                 coalesce(sum(k.n), 0)::int codes,
                 coalesce(sum(k.n) filter (where b.biz_cd = any(${textArray(bizCds)})), 0)::int codes_in,
                 array_remove(array_agg(distinct case when b.biz_cd <> all(${textArray(bizCds)}) then b.biz_cd end), null) missing
            from std_code_cls c
            join prj_biz_area b on b.biz_area_id = c.biz_area_id
            left join (select code_cls_id, count(*) n from std_code where project_id = ${s.codes.projectId} group by code_cls_id) k
              on k.code_cls_id = c.code_cls_id
           where c.project_id = ${s.codes.projectId}`,
    );
    const r = rows[0] as {
      cls: number;
      cls_in: number;
      codes: number;
      codes_in: number;
      missing: string[] | null;
    };
    const warnings: ValidationIssue[] = [];
    const missing = r.missing ?? [];
    // 업무구분과 코드의 원본이 같으면 미선택 업무구분의 코드는 의도한 제외다. 원본이 다를 때만 "없는 업무구분" 경고.
    if (missing.length > 0 && !sameSource(s.codes, s.bizAreas)) {
      warnings.push({
        code: 'W_COPY_BIZ_AREA_MISSING',
        message: `${COPY_WARNING_CODES.W_COPY_BIZ_AREA_MISSING}: ${missing.sort().join(', ')}`,
      });
    }
    counts.CODE_CLS = { sourceCnt: n(r.cls), toCopy: n(r.cls_in), warnings };
    counts.CODE = { sourceCnt: n(r.codes), toCopy: n(r.codes_in), warnings: [] };
  }
  await simple('DEFAULT_COL_SET', sql`std_default_col_set`, s.defaultColSets);
  await simple('DEFAULT_COL', sql`std_default_col`, s.defaultColSets);
  return { counts, bizCds };
}

function planWarnings(plan: CopyPlan): ValidationIssue[] {
  const w = [...plan.warnings];
  if (needsC3(plan.sources)) {
    w.push({ code: 'W_COPY_SOURCE_MIXED', message: COPY_WARNING_CODES.W_COPY_SOURCE_MIXED });
  }
  return w;
}

export async function previewCopy(q: Q, plan: CopyPlan): Promise<CopyPreviewResponse> {
  const { counts } = await countPlan(q, plan);
  const items: CopyPreviewItem[] = ENTITY_ORDER.map((e) => {
    const src = plan.sources[ENTITY_ITEM_KEY[e]];
    const c = counts[e];
    return {
      item: e,
      sourceKind: src.kind,
      sourceKey: src.key,
      sourceCnt: c.sourceCnt,
      toCopy: c.toCopy,
      toSkip: c.sourceCnt - c.toCopy,
      warnings: c.warnings,
    };
  });
  return {
    items,
    c3Expected: needsC3(plan.sources),
    warnings: [...planWarnings(plan), ...items.flatMap((i) => i.warnings)],
  };
}

/** 실행 결과(서비스 응답·러너 로그 공용). */
export interface CopyOutcome extends ProjectCreateResponse {
  c3: C3Result | null;
}

async function stage<T>(step: CopyStep, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ProblemException) throw e;
    throw new CopyFailedProblem(step, e);
  }
}

async function rowCount(q: Q, query: SQL): Promise<number> {
  const r = await q.execute(query);
  return r.rowCount ?? 0;
}

/**
 * 계획 실행. `db`는 트랜잭션 밖의 Db여야 한다(엔진이 repeatable read 트랜잭션을 연다).
 * `verify`는 커밋 직전 같은 트랜잭션에서 부른다 — 예외를 던지면 전부 롤백(러너의 건수 검증).
 */
export async function executeCopy(
  db: Db,
  plan: CopyPlan,
  a: Audit,
  opts: { verify?: (out: CopyOutcome) => void | Promise<void> } = {},
): Promise<CopyOutcome> {
  const t0 = performance.now();
  const batchId = randomUUID();
  return db.transaction(
    async (tx) => {
      const { counts, bizCds } = await countPlan(tx, plan);
      const s = plan.sources;
      const elapsed: Partial<Record<StdEntityType, number>> = {};
      const copied: Partial<Record<StdEntityType, number>> = {};
      const timed = async (e: StdEntityType, step: CopyStep, fn: () => Promise<number>) => {
        const ts = performance.now();
        copied[e] = await stage(step, fn);
        elapsed[e] = Math.round(performance.now() - ts);
      };
      const stamp = sql`${a.actor}, ${a.ip}, ${a.actor}, ${a.ip}`;

      // 1 프로젝트 행 + 생성자(ADMIN) + 3단계 멤버
      const projectId = await stage('PROJECT', async () => {
        const [row] = await insertAudited(
          tx,
          tfProject,
          {
            projectKey: plan.target.projectKey,
            projectNm: plan.target.projectNm,
            description: plan.target.description,
            kind: plan.target.kind,
            status: 'ACTIVE',
            defaultDialect: plan.target.defaultDialect,
            copiedFromProjectId: representativeSource(s),
          },
          a,
        )
          .onConflictDoNothing()
          .returning({ id: tfProject.projectId });
        if (!row) throw new ConflictProblem('E_PROJECT_KEY_DUP', API_ERROR_CODES.E_PROJECT_KEY_DUP);
        await insertMembers(tx, row.id, plan, a);
        return row.id;
      });

      // 2 업무구분
      await timed('BIZ_AREA', 'BIZ_AREA', async () =>
        s.bizAreas.projectId === null
          ? 0
          : rowCount(
              tx,
              sql`insert into prj_biz_area (project_id, biz_cd, biz_nm, table_prefix, sort_no, use_yn, description,
                                            origin_project_id, origin_id, created_by, created_ip, updated_by, updated_ip)
                  select ${projectId}, b.biz_cd, b.biz_nm, b.table_prefix, b.sort_no, b.use_yn, b.description,
                         b.project_id, b.biz_area_id, ${stamp}
                    from prj_biz_area b
                   where b.project_id = ${s.bizAreas.projectId} and b.biz_cd = any(${textArray(bizCds)})
                   order by b.sort_no, b.biz_cd`,
            ),
      );
      // 3 도메인분류
      await timed('DOMAIN_CLS', 'DOMAIN_CLS', async () =>
        s.domainClasses.projectId === null
          ? 0
          : rowCount(
              tx,
              sql`insert into std_domain_cls (project_id, suffix, cls_nm, col_type, col_length, col_scale, description, review_yn,
                                              origin_project_id, origin_id, created_by, created_ip, updated_by, updated_ip)
                  select ${projectId}, c.suffix, c.cls_nm, c.col_type, c.col_length, c.col_scale, c.description, c.review_yn,
                         c.project_id, c.domain_cls_id, ${stamp}
                    from std_domain_cls c where c.project_id = ${s.domainClasses.projectId}
                   order by c.domain_cls_id`,
            ),
      );
      // 4 용어(상태·검토 값 그대로)
      await timed('TERM', 'TERM', async () =>
        s.terms.projectId === null
          ? 0
          : rowCount(
              tx,
              sql`insert into std_term (project_id, term_kor, term_physical, description, synonym_ref, status, review_yn,
                                        review_note, reviewed_by, reviewed_at,
                                        origin_project_id, origin_id, created_by, created_ip, updated_by, updated_ip)
                  select ${projectId}, t.term_kor, t.term_physical, t.description, t.synonym_ref, t.status, t.review_yn,
                         t.review_note, t.reviewed_by, t.reviewed_at, t.project_id, t.term_id, ${stamp}
                    from std_term t
                   where t.project_id = ${s.terms.projectId}
                     and (not ${plan.approvedOnly}::boolean or t.status = 'APPROVED')
                   order by t.term_id`,
            ),
      );
      // 5 도메인(도메인분류는 새 프로젝트에서 suffix 자연키로 재매핑, 없으면 NULL → 9단계)
      await timed('DOMAIN', 'DOMAIN', async () =>
        s.domains.projectId === null
          ? 0
          : rowCount(
              tx,
              sql`insert into std_domain (project_id, nm1, nm2, nm3, nm4, nm5, nm6, nm7, logical_nm, physical_nm, descr, suffix,
                                          domain_cls_id, col_type, col_length, col_scale, type_source, review_yn, review_note,
                                          origin_project_id, origin_id, created_by, created_ip, updated_by, updated_ip)
                  select ${projectId}, d.nm1, d.nm2, d.nm3, d.nm4, d.nm5, d.nm6, d.nm7, d.logical_nm, d.physical_nm, d.descr,
                         d.suffix, nc.domain_cls_id, d.col_type, d.col_length, d.col_scale, d.type_source, d.review_yn,
                         d.review_note, d.project_id, d.domain_id, ${stamp}
                    from std_domain d
                    left join std_domain_cls nc on nc.project_id = ${projectId} and nc.suffix = d.suffix
                   where d.project_id = ${s.domains.projectId}
                   order by d.domain_id`,
            ),
      );
      // 6 코드구분(업무구분은 biz_cd 자연키로 재매핑 — 새 프로젝트에 없는 업무구분은 제외)
      await timed('CODE_CLS', 'CODE_CLS', async () =>
        s.codes.projectId === null
          ? 0
          : rowCount(
              tx,
              sql`insert into std_code_cls (project_id, biz_area_id, code_cls, code_cls_nm, description,
                                            origin_project_id, origin_id, created_by, created_ip, updated_by, updated_ip)
                  select ${projectId}, nb.biz_area_id, c.code_cls, c.code_cls_nm, c.description, c.project_id, c.code_cls_id, ${stamp}
                    from std_code_cls c
                    join prj_biz_area sb on sb.biz_area_id = c.biz_area_id
                    join prj_biz_area nb on nb.project_id = ${projectId} and nb.biz_cd = sb.biz_cd
                   where c.project_id = ${s.codes.projectId}
                   order by c.code_cls_id`,
            ),
      );
      // 7 코드(같은 원본의 하위 행: 출처 컬럼으로 조인)
      await timed('CODE', 'CODE', async () =>
        s.codes.projectId === null
          ? 0
          : rowCount(
              tx,
              sql`insert into std_code (project_id, code_cls_id, code, code_nm, sort_order, is_active,
                                        origin_project_id, origin_id, created_by, created_ip, updated_by, updated_ip)
                  select ${projectId}, nc.code_cls_id, x.code, x.code_nm, x.sort_order, x.is_active, x.project_id, x.code_id, ${stamp}
                    from std_code x
                    join std_code_cls nc on nc.project_id = ${projectId} and nc.origin_project_id = ${s.codes.projectId}
                                        and nc.origin_id = x.code_cls_id
                   where x.project_id = ${s.codes.projectId}
                   order by x.code_id`,
            ),
      );
      // 8 기본컬럼 세트·구성 + 프로젝트 기본 세트 지정
      await timed('DEFAULT_COL_SET', 'DEFAULT_COL_SET', async () =>
        s.defaultColSets.projectId === null
          ? 0
          : rowCount(
              tx,
              sql`insert into std_default_col_set (project_id, set_nm, description, is_default,
                                                   origin_project_id, origin_id, created_by, created_ip, updated_by, updated_ip)
                  select ${projectId}, t.set_nm, t.description, t.is_default, t.project_id, t.set_id, ${stamp}
                    from std_default_col_set t where t.project_id = ${s.defaultColSets.projectId}
                   order by t.set_id`,
            ),
      );
      await timed('DEFAULT_COL', 'DEFAULT_COL', async () => {
        if (s.defaultColSets.projectId === null) return 0;
        const cnt = await rowCount(
          tx,
          sql`insert into std_default_col (project_id, set_id, col_seq, logical_nm, physical_nm, is_pk, data_type, data_length,
                                           data_scale, is_nullable, default_val, col_comment,
                                           origin_project_id, origin_id, created_by, created_ip, updated_by, updated_ip)
              select ${projectId}, ns.set_id, c.col_seq, c.logical_nm, c.physical_nm, c.is_pk, c.data_type, c.data_length,
                     c.data_scale, c.is_nullable, c.default_val, c.col_comment, c.project_id, c.default_col_id, ${stamp}
                from std_default_col c
                join std_default_col_set ns on ns.project_id = ${projectId} and ns.origin_project_id = ${s.defaultColSets.projectId}
                                           and ns.origin_id = c.set_id
               where c.project_id = ${s.defaultColSets.projectId}
               order by c.set_id, c.col_seq`,
        );
        await updateAudited(
          tx,
          tfProject,
          {
            defaultColSetId: sql`coalesce(
              (select ns.set_id from std_default_col_set ns
                 join tf_project sp on sp.project_id = ${s.defaultColSets.projectId}
                where ns.project_id = ${projectId} and ns.origin_id = sp.default_col_set_id),
              (select ns.set_id from std_default_col_set ns where ns.project_id = ${projectId} and ns.is_default))`,
          },
          a,
        ).where(eq(tfProject.projectId, projectId));
        return cnt;
      });

      // 9 C3 재검증
      let c3: C3Result | null = null;
      if (needsC3(s) && s.domains.projectId !== null) {
        const ts = performance.now();
        c3 = await stage('C3', () => revalidateC3(tx, projectId, s.domains.projectId!));
        elapsed.DOMAIN = (elapsed.DOMAIN ?? 0) + Math.round(performance.now() - ts);
      }

      // 10 기록: project_copy_log 8행 + 감사 COPY 요약(항목당 1행)
      const warnings = planWarnings(plan);
      const items: CopyItemResult[] = ENTITY_ORDER.map((e) => {
        const src = s[ENTITY_ITEM_KEY[e]];
        const c = counts[e];
        const cp = copied[e] ?? 0;
        return {
          item: e,
          sourceKind: src.kind,
          sourceKey: src.key,
          sourceCnt: c.sourceCnt,
          copied: cp,
          skipped: Math.max(0, c.sourceCnt - cp),
          flagged: e === 'DOMAIN' ? (c3?.flagged ?? 0) : 0,
          elapsedMs: elapsed[e] ?? 0,
        };
      });
      const itemWarnings = (e: StdEntityType): ValidationIssue[] => [
        ...counts[e].warnings,
        ...(e === 'DOMAIN' && c3 !== null
          ? [{ code: 'W_COPY_SOURCE_MIXED', message: COPY_WARNING_CODES.W_COPY_SOURCE_MIXED }]
          : []),
        ...(e === 'CODE_CLS' ? plan.warnings.filter((w) => w.code === 'W_COPY_CODES_EMPTIED') : []),
      ];
      const reviewDomainCnt = await stage('LOG', async () => {
        await tx.insert(projectCopyLog).values(
          items.map((it) => ({
            projectId,
            batchId,
            operation: plan.operation,
            item: it.item,
            sourceKind: it.sourceKind!,
            sourceProjectId: s[ENTITY_ITEM_KEY[it.item]].projectId,
            options: optionsOf(plan, ENTITY_ITEM_KEY[it.item], bizCds),
            sourceCnt: it.sourceCnt,
            copiedCnt: it.copied,
            skippedCnt: it.skipped,
            flaggedCnt: it.flagged,
            warnings: itemWarnings(it.item),
            elapsedMs: it.elapsedMs ?? 0,
            copiedBy: a.actor,
          })),
        );
        await writeStdAudit(
          tx,
          items.map((it) => ({
            projectId,
            entityType: it.item,
            entityId: projectId,
            action: 'COPY' as const,
            after: {
              operation: plan.operation,
              source: { kind: it.sourceKind, key: it.sourceKey },
              counts: {
                source: it.sourceCnt,
                copied: it.copied,
                skipped: it.skipped,
                flagged: it.flagged,
              },
            },
            batchId,
          })),
          a,
        );
        return scalar(
          tx,
          sql`select count(*)::int n from std_domain where project_id = ${projectId} and review_yn`,
        );
      });

      const c3Revalidation: C3Revalidation = {
        performed: c3 !== null,
        ...(c3 !== null ? { reason: c3ReasonText(s) } : {}),
        reviewDomainCnt,
        flaggedCnt: c3?.flagged ?? 0,
        reviewListUrl: `/projects/${plan.target.projectKey}/standards/domains?review=true`,
        samples: c3?.samples ?? [],
      };
      const outcome: CopyOutcome = {
        projectKey: plan.target.projectKey,
        projectId,
        batchId,
        elapsedMs: Math.round(performance.now() - t0),
        items,
        c3Revalidation,
        warnings: [...warnings, ...ENTITY_ORDER.flatMap((e) => counts[e].warnings)],
        c3,
      };
      if (opts.verify) await opts.verify(outcome);
      return outcome;
    },
    { isolationLevel: 'repeatable read' },
  );
}

function optionsOf(plan: CopyPlan, k: CopyItemKey, bizCds: string[]): Record<string, unknown> {
  if (k === 'bizAreas') return { bizCds: plan.bizCds ?? 'ALL', copiedBizCds: bizCds };
  if (k === 'terms') return { approvedOnly: plan.approvedOnly };
  if (k === 'codes') return { bizCds };
  return {};
}

function c3ReasonText(s: Record<CopyItemKey, CopySource>): string {
  const label = (x: CopySource) => (x.kind === 'EMPTY' ? '비움' : (x.key ?? '?'));
  const t = label(s.terms);
  const c = label(s.domainClasses);
  const d = label(s.domains);
  return t === c
    ? `용어·도메인분류(${t})와 도메인(${d}) 원본이 다름`
    : `용어(${t})·도메인분류(${c})·도메인(${d}) 원본이 다름`;
}

/** 생성자(ADMIN) + 3단계 멤버. 생성자 역할은 항상 ADMIN(§4.3), 존재·활성 사용자만. */
async function insertMembers(q: Q, projectId: number, plan: CopyPlan, a: Audit): Promise<void> {
  const roles = new Map<number, string>();
  for (const m of plan.members) roles.set(m.userId, m.role);
  if (plan.creatorUserId !== null) roles.set(plan.creatorUserId, 'ADMIN');
  if (roles.size === 0) return;
  if (plan.target.kind === 'TEMPLATE') return; // 템플릿에는 멤버를 두지 않는다(§4.6)
  const ids = [...roles.keys()];
  const users = await q
    .select({ id: tfUser.userId, active: tfUser.isActive })
    .from(tfUser)
    .where(inArray(tfUser.userId, ids));
  const found = new Map(users.map((u) => [u.id, u.active]));
  const errors: ValidationIssue[] = [];
  plan.members.forEach((m, i) => {
    if (!found.has(m.userId))
      errors.push({
        code: 'E_NOT_FOUND',
        target: 'field',
        field: `members.${i}.userId`,
        message: `사용자 ${m.userId}을(를) 찾을 수 없습니다`,
      });
    else if (!found.get(m.userId))
      errors.push({
        code: 'E_USER_INACTIVE',
        target: 'field',
        field: `members.${i}.userId`,
        message: API_ERROR_CODES.E_USER_INACTIVE,
      });
  });
  if (errors.length > 0) throw new ValidationProblem(errors);
  await insertAudited(
    q,
    tfProjectMember,
    ids
      .filter((id) => found.has(id))
      .map((userId) => ({ projectId, userId, memberRole: roles.get(userId)! })),
    a,
  );
}

/** Nest 주입용 래퍼(서비스·컨트롤러). 러너는 executeCopy를 직접 부른다. */
@Injectable()
export class ProjectCopyService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  preview(plan: CopyPlan): Promise<CopyPreviewResponse> {
    return this.db.transaction((tx) => previewCopy(tx, plan), {
      isolationLevel: 'repeatable read',
    });
  }

  execute(plan: CopyPlan, a: Audit): Promise<CopyOutcome> {
    return executeCopy(this.db, plan, a);
  }
}
