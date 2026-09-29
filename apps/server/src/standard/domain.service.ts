import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  API_ERROR_CODES,
  typeText,
  type DomainCalcResult,
  type DomainCalculateInput,
  type DomainDetail,
  type DomainInput,
  type DomainItem,
  type DomainListQuery,
  type DomainPage,
  type DomainRecalcResponse,
  type DomainSaveResponse,
  type StdType,
  type TypeSource,
} from '@termflow/shared';
import type { L1Snapshot } from '../autocomplete/domain-calculator.js';
import { loadL1Snapshot } from '../autocomplete/l1-snapshot.js';
import type { Audit } from '../common/audit/audit.js';
import { ConflictProblem, NotFoundProblem } from '../common/problem/problem.exception.js';
import type { ProjectCtx } from '../common/project-context.js';
import { insertAudited, updateAudited } from '../db/audit.js';
import type { Db } from '../db/client.js';
import { DRIZZLE } from '../db/db.module.js';
import { stdDomain } from '../db/schema.js';
import {
  planDomain,
  planFields,
  recalcDomain,
  type DomainPlan,
  type StoredDomain,
} from './domain-plan.js';
import { auditJson, writeStdAudit } from './std-audit.js';
import {
  chunks,
  isoTs,
  likePattern,
  limitOffset,
  orderBy,
  rowsOf,
  throwIfErrors,
  whereAll,
  type ExecQ,
} from './std-sql.js';
import { StdWriter, type Tx } from './std-write.js';

interface DomainRow {
  domain_id: number;
  nm1: string;
  nm2: string | null;
  nm3: string | null;
  nm4: string | null;
  nm5: string | null;
  nm6: string | null;
  nm7: string | null;
  logical_nm: string;
  physical_nm: string | null;
  descr: string | null;
  suffix: string | null;
  domain_cls_id: number | null;
  col_type: StdType | null;
  col_length: number | null;
  col_scale: number | null;
  type_source: TypeSource;
  review_yn: boolean;
  review_note: string | null;
  updated_by: string;
  updated_at: string;
}

const COLUMNS = sql`d.domain_id, d.nm1, d.nm2, d.nm3, d.nm4, d.nm5, d.nm6, d.nm7, d.logical_nm, d.physical_nm,
  d.descr, d.suffix, d.domain_cls_id, d.col_type, d.col_length, d.col_scale, d.type_source, d.review_yn,
  d.review_note, d.updated_by, ${isoTs(sql`d.updated_at`)} updated_at`;

export function mapDomain(r: DomainRow): DomainItem {
  return {
    domainId: r.domain_id,
    nm: [r.nm1, r.nm2, r.nm3, r.nm4, r.nm5, r.nm6, r.nm7],
    logicalNm: r.logical_nm,
    physicalNm: r.physical_nm,
    descr: r.descr,
    suffix: r.suffix,
    domainClsId: r.domain_cls_id,
    colType: r.col_type,
    colLength: r.col_length,
    colScale: r.col_scale,
    typeText: typeText(r.col_type, r.col_length, r.col_scale),
    typeSource: r.type_source,
    reviewYn: r.review_yn,
    reviewNote: r.review_note,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  };
}

const SORTS = {
  logicalNm: sql`d.logical_nm collate "C"`,
  physicalNm: sql`d.physical_nm collate "C"`,
  suffix: sql`d.suffix collate "C"`,
  colType: sql`d.col_type`,
  updatedAt: sql`d.updated_at`,
} as const;

/** 재계산 응답 report 상한. */
const REPORT_MAX = 1000;

/**
 * 도메인(T6.4, 설계서 §3.5.7·§5.2·§4.8). 저장 시 L1으로 논리명·물리명·접미어·타입을 계산한다(`domain-plan.ts`).
 * 논리명 중복 409 `E_DOMAIN_DUP`, 미등록 조각은 물리명 NULL + 검토필요(R15). 재계산은 `REVIEW_ONLY`/`ALL_AUTO`(MANUAL 타입 유지).
 */
@Injectable()
export class DomainService {
  private readonly logger = new Logger('Domains');

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly writer: StdWriter,
  ) {}

  async list(ctx: ProjectCtx, q: DomainListQuery): Promise<DomainPage> {
    const pid = ctx.projectId;
    const search = q.q
      ? sql`(d.logical_nm ilike ${likePattern(q.q)} or d.physical_nm ilike ${likePattern(q.q)})`
      : undefined;
    const suffix = q.suffix ? sql`d.suffix = ${q.suffix.toUpperCase()}` : undefined;
    const base = [sql`d.project_id = ${pid}`, search, suffix];
    const where = whereAll([
      ...base,
      q.review === undefined ? undefined : sql`d.review_yn = ${q.review}`,
      q.typeSource ? sql`d.type_source = ${q.typeSource}` : undefined,
      q.noPhysical ? sql`d.physical_nm is null` : undefined,
    ]);
    const [rows, [cnt], [counts]] = await Promise.all([
      rowsOf<DomainRow>(
        this.db,
        sql`select ${COLUMNS} from std_domain d where ${where}
            order by ${orderBy(q.sort, SORTS, sql`d.logical_nm collate "C" asc`, sql`d.domain_id asc`)} ${limitOffset(q)}`,
      ),
      rowsOf<{ n: number }>(this.db, sql`select count(*)::int n from std_domain d where ${where}`),
      rowsOf<DomainPage['counts']>(
        this.db,
        sql`select count(*)::int "all", count(*) filter (where d.review_yn)::int review,
                   count(*) filter (where d.physical_nm is null)::int "noPhysical",
                   count(*) filter (where d.type_source = 'MANUAL')::int manual
              from std_domain d where ${whereAll(base)}`,
      ),
    ]);
    return {
      items: rows.map(mapDomain),
      page: q.page,
      size: q.size,
      total: cnt?.n ?? 0,
      counts: counts ?? { all: 0, review: 0, noPhysical: 0, manual: 0 },
    };
  }

  private async row(q: ExecQ, projectId: number, id: number): Promise<DomainRow> {
    const [r] = await rowsOf<DomainRow>(
      q,
      sql`select ${COLUMNS} from std_domain d where d.project_id = ${projectId} and d.domain_id = ${id}`,
    );
    if (!r) throw new NotFoundProblem('도메인을 찾을 수 없습니다');
    return r;
  }

  async detail(ctx: ProjectCtx, id: number): Promise<DomainDetail> {
    const r = await this.row(this.db, ctx.projectId, id);
    const snap = await loadL1Snapshot(this.db, ctx.projectId);
    const plan = planDomain(
      {
        nm: [r.nm1, r.nm2, r.nm3, r.nm4, r.nm5, r.nm6, r.nm7],
        typeSource: r.type_source,
        colType: r.col_type,
        colLength: r.col_length,
        colScale: r.col_scale,
      },
      snap,
    );
    const [c] = await rowsOf<{ n: number }>(
      this.db,
      sql`select count(*)::int n from prj_column where project_id = ${ctx.projectId} and domain_id = ${id}`,
    );
    return { domain: mapDomain(r), pieces: plan.pieces, columnCnt: c?.n ?? 0 };
  }

  private async logicalOwner(
    q: ExecQ,
    projectId: number,
    logicalNm: string,
    exceptId: number | null,
  ): Promise<{ domainId: number; logicalNm: string } | null> {
    const [r] = await rowsOf<{ domain_id: number; logical_nm: string }>(
      q,
      sql`select domain_id, logical_nm from std_domain
           where project_id = ${projectId} and logical_nm = ${logicalNm}
             ${exceptId !== null ? sql`and domain_id <> ${exceptId}` : sql``}`,
    );
    return r ? { domainId: r.domain_id, logicalNm: r.logical_nm } : null;
  }

  /** L1 미리보기(§5.2, 명칭 1~7 입력 즉시). 저장과 같은 계획 함수를 쓴다. */
  async calculate(ctx: ProjectCtx, input: DomainCalculateInput): Promise<DomainCalcResult> {
    const snap = await loadL1Snapshot(this.db, ctx.projectId);
    const plan = planDomain(
      {
        nm: [input.nm1, input.nm2, input.nm3, input.nm4, input.nm5, input.nm6, input.nm7],
        typeSource: input.typeSource,
        colType: input.colType,
        colLength: input.colLength,
        colScale: input.colScale,
      },
      snap,
    );
    const duplicate =
      plan.logicalNm !== ''
        ? await this.logicalOwner(this.db, ctx.projectId, plan.logicalNm, input.domainId)
        : null;
    return {
      logicalNm: plan.logicalNm,
      physicalNm: plan.physicalNm,
      assembledPhysical: plan.assembledPhysical,
      descr: plan.descr,
      suffix: plan.suffix,
      domainClsId: plan.domainClsId,
      colType: plan.colType,
      colLength: plan.colLength,
      colScale: plan.colScale,
      typeText: plan.typeText,
      typeSource: plan.typeSource,
      pieces: plan.pieces,
      notFound: plan.notFound,
      reviewReasons: plan.reviewReasons,
      duplicate,
      errors: [
        ...plan.errors,
        ...(duplicate
          ? [
              {
                code: 'E_DOMAIN_DUP',
                target: 'field' as const,
                field: 'logicalNm',
                message: `${API_ERROR_CODES.E_DOMAIN_DUP}: ${plan.logicalNm}`,
              },
            ]
          : []),
      ],
      warnings: plan.warnings,
    };
  }

  private plan(input: DomainInput, snap: L1Snapshot): DomainPlan {
    const plan = planDomain(
      {
        nm: [input.nm1, input.nm2, input.nm3, input.nm4, input.nm5, input.nm6, input.nm7],
        typeSource: input.typeSource,
        colType: input.colType,
        colLength: input.colLength,
        colScale: input.colScale,
      },
      snap,
    );
    throwIfErrors(plan.errors, plan.warnings);
    return plan;
  }

  private dup(logicalNm: string, domainId: number): ConflictProblem {
    return new ConflictProblem('E_DOMAIN_DUP', `${API_ERROR_CODES.E_DOMAIN_DUP}: ${logicalNm}`, {
      logicalNm,
      domainId,
    });
  }

  async create(ctx: ProjectCtx, input: DomainInput, a: Audit): Promise<DomainSaveResponse> {
    this.writer.assertWritable(ctx);
    const plan = this.plan(input, await loadL1Snapshot(this.db, ctx.projectId));
    const owner = await this.logicalOwner(this.db, ctx.projectId, plan.logicalNm, null);
    if (owner) throw this.dup(plan.logicalNm, owner.domainId);
    const id = await this.writer.write(ctx, async (tx) => {
      const [r] = await insertAudited(
        tx,
        stdDomain,
        { projectId: ctx.projectId, ...planFields(plan) },
        a,
      )
        .onConflictDoNothing()
        .returning();
      if (!r) throw this.dup(plan.logicalNm, 0);
      await writeStdAudit(
        tx,
        {
          projectId: ctx.projectId,
          entityType: 'DOMAIN',
          entityId: r.domainId,
          action: 'INSERT',
          after: auditJson(r),
        },
        a,
      );
      return r.domainId;
    });
    this.logger.log(
      `도메인 등록: ${ctx.projectKey} ${plan.logicalNm}=${plan.physicalNm ?? '(검토)'} by ${a.actor}`,
    );
    return {
      domain: mapDomain(await this.row(this.db, ctx.projectId, id)),
      warnings: plan.warnings,
    };
  }

  /**
   * 수정: 명칭 조각이 그대로이고 저장 물리명이 있으면 물리명을 유지한다(승계 원본 물리명 보존) — 조각을 바꾸면 L1으로 다시 만든다.
   */
  async update(
    ctx: ProjectCtx,
    id: number,
    input: DomainInput,
    a: Audit,
  ): Promise<DomainSaveResponse> {
    this.writer.assertWritable(ctx);
    const [cur] = await this.db
      .select()
      .from(stdDomain)
      .where(and(eq(stdDomain.projectId, ctx.projectId), eq(stdDomain.domainId, id)));
    if (!cur) throw new NotFoundProblem('도메인을 찾을 수 없습니다');
    const plan = this.plan(input, await loadL1Snapshot(this.db, ctx.projectId));
    const owner = await this.logicalOwner(this.db, ctx.projectId, plan.logicalNm, id);
    if (owner) throw this.dup(plan.logicalNm, owner.domainId);
    const curNm = [cur.nm1, cur.nm2, cur.nm3, cur.nm4, cur.nm5, cur.nm6, cur.nm7];
    const sameParts = curNm.every((v, i) => (v ?? null) === (plan.nm[i] ?? null));
    const fields = planFields(plan);
    if (sameParts && cur.physicalNm !== null && fields.physicalNm !== cur.physicalNm) {
      fields.physicalNm = cur.physicalNm;
      fields.descr = cur.descr ?? fields.descr;
      // 물리명을 유지했으므로 "물리명 없음" 계열 검토 사유는 해당 없음
      const rest = plan.reviewReasons.filter(
        (r) => !r.startsWith('미등록 조각') && !r.startsWith('물리명'),
      );
      fields.reviewYn = rest.length > 0;
      fields.reviewNote = rest.length > 0 ? rest.join('; ') : null;
    }
    await this.writer.write(ctx, async (tx) => {
      const [after] = await updateAudited(tx, stdDomain, fields, a)
        .where(eq(stdDomain.domainId, id))
        .returning();
      await writeStdAudit(
        tx,
        {
          projectId: ctx.projectId,
          entityType: 'DOMAIN',
          entityId: id,
          action: 'UPDATE',
          before: auditJson(cur),
          after: auditJson(after),
        },
        a,
      );
    });
    return {
      domain: mapDomain(await this.row(this.db, ctx.projectId, id)),
      warnings: plan.warnings,
    };
  }

  /** 삭제: 이 도메인을 쓰던 컬럼의 domain_id는 SET NULL(열 지정, §4.8) — 응답에 연결 해제 수. */
  async remove(ctx: ProjectCtx, id: number, a: Audit): Promise<{ unlinkedColumns: number }> {
    this.writer.assertWritable(ctx);
    const [cur] = await this.db
      .select()
      .from(stdDomain)
      .where(and(eq(stdDomain.projectId, ctx.projectId), eq(stdDomain.domainId, id)));
    if (!cur) throw new NotFoundProblem('도메인을 찾을 수 없습니다');
    const [c] = await rowsOf<{ n: number }>(
      this.db,
      sql`select count(*)::int n from prj_column where project_id = ${ctx.projectId} and domain_id = ${id}`,
    );
    await this.writer.write(ctx, async (tx) => {
      await tx.delete(stdDomain).where(eq(stdDomain.domainId, id));
      await writeStdAudit(
        tx,
        {
          projectId: ctx.projectId,
          entityType: 'DOMAIN',
          entityId: id,
          action: 'DELETE',
          before: auditJson(cur),
          after: { unlinkedColumns: c?.n ?? 0 },
        },
        a,
      );
    });
    return { unlinkedColumns: c?.n ?? 0 };
  }

  /**
   * 재계산(§4.8, T6.4 DoD): REVIEW_ONLY = 검토필요 도메인, ALL_AUTO = 타입 출처 AUTO 도메인 전부.
   * 규칙은 `recalcDomain`(CR-05 C4). 바뀐 행만 `unnest` 일괄 UPDATE + 감사 IMPORT(batch_id, 행당 1건, §8.5 "재계산").
   */
  async recalculate(
    ctx: ProjectCtx,
    scope: 'REVIEW_ONLY' | 'ALL_AUTO',
    a: Audit,
  ): Promise<DomainRecalcResponse> {
    this.writer.assertWritable(ctx);
    const t0 = performance.now();
    const batchId = randomUUID();
    const result = await this.writer.write(ctx, async (tx) => {
      const snap = await loadL1Snapshot(tx, ctx.projectId);
      const rows = await rowsOf<DomainRow>(
        tx,
        sql`select ${COLUMNS} from std_domain d
             where d.project_id = ${ctx.projectId}
               and ${scope === 'REVIEW_ONLY' ? sql`d.review_yn` : sql`d.type_source = 'AUTO'`}
             order by d.domain_id
             for update`,
      );
      const changed: { d: StoredDomain; r: ReturnType<typeof recalcDomain> }[] = [];
      let stillReview = 0;
      let resolved = 0;
      for (const row of rows) {
        const d = toStored(row);
        const r = recalcDomain(d, snap);
        if (r.next.reviewYn) stillReview++;
        if (d.reviewYn && !r.next.reviewYn) resolved++;
        if (Object.keys(r.changes).length > 0) changed.push({ d, r });
      }
      await applyRecalc(tx, ctx.projectId, changed, a);
      await writeStdAudit(
        tx,
        changed.map(({ d, r }) => ({
          projectId: ctx.projectId,
          entityType: 'DOMAIN' as const,
          entityId: d.domainId,
          action: 'IMPORT' as const,
          before: pickChanged(d, r.changes, 0),
          after: { ...pickChanged(d, r.changes, 1), operation: `RECALCULATE_${scope}` },
          batchId,
        })),
        a,
      );
      return { target: rows.length, changed, stillReview, resolved };
    });
    const elapsedMs = Math.round(performance.now() - t0);
    this.logger.log(
      `도메인 재계산(${scope}): ${ctx.projectKey} 대상 ${result.target} · 변경 ${result.changed.length} · 해제 ${result.resolved} · 잔여 ${result.stillReview} (${elapsedMs}ms) by ${a.actor}`,
    );
    return {
      scope,
      target: result.target,
      updated: result.changed.length,
      resolved: result.resolved,
      stillReview: result.stillReview,
      batchId: result.changed.length > 0 ? batchId : null,
      elapsedMs,
      report: result.changed.slice(0, REPORT_MAX).map(({ d, r }) => ({
        domainId: d.domainId,
        logicalNm: d.logicalNm,
        changes: r.changes,
        reviewYn: r.next.reviewYn,
        reviewNote: r.next.reviewNote,
      })),
    };
  }

  /** 논리명 → 도메인 ID(일괄 등록 키 매칭). */
  async idsByLogical(q: ExecQ, projectId: number): Promise<Map<string, number>> {
    const rows = await rowsOf<{ domain_id: number; logical_nm: string }>(
      q,
      sql`select domain_id, logical_nm from std_domain where project_id = ${projectId}`,
    );
    return new Map(rows.map((r) => [r.logical_nm, r.domain_id]));
  }
}

function toStored(r: DomainRow): StoredDomain {
  return {
    domainId: r.domain_id,
    nm: [r.nm1, r.nm2, r.nm3, r.nm4, r.nm5, r.nm6, r.nm7],
    logicalNm: r.logical_nm,
    physicalNm: r.physical_nm,
    descr: r.descr,
    suffix: r.suffix,
    domainClsId: r.domain_cls_id,
    colType: r.col_type,
    colLength: r.col_length,
    colScale: r.col_scale,
    typeSource: r.type_source,
    reviewYn: r.review_yn,
    reviewNote: r.review_note,
  };
}

function pickChanged(
  d: StoredDomain,
  changes: Record<string, [unknown, unknown]>,
  idx: 0 | 1,
): Record<string, unknown> {
  const out: Record<string, unknown> = { logicalNm: d.logicalNm };
  for (const [k, v] of Object.entries(changes)) out[k] = v[idx];
  return out;
}

async function applyRecalc(
  tx: Tx,
  projectId: number,
  changed: { d: StoredDomain; r: ReturnType<typeof recalcDomain> }[],
  a: Audit,
): Promise<void> {
  for (const part of chunks(changed, 1000)) {
    const col = <K extends keyof ReturnType<typeof recalcDomain>['next']>(k: K) =>
      part.map(({ r }) => r.next[k]);
    await tx.execute(
      sql`update std_domain d
             set physical_nm = u.physical_nm, descr = u.descr, suffix = u.suffix, domain_cls_id = u.domain_cls_id,
                 col_type = u.col_type, col_length = u.col_length, col_scale = u.col_scale,
                 review_yn = u.review_yn, review_note = u.review_note,
                 updated_at = CURRENT_TIMESTAMP, updated_by = ${a.actor}, updated_ip = ${a.ip}
            from unnest(${sql.param(part.map(({ d }) => d.domainId))}::int[],
                        ${sql.param(col('physicalNm'))}::text[], ${sql.param(col('descr'))}::text[],
                        ${sql.param(col('suffix'))}::text[], ${sql.param(col('domainClsId'))}::int[],
                        ${sql.param(col('colType'))}::text[], ${sql.param(col('colLength'))}::int[],
                        ${sql.param(col('colScale'))}::int[], ${sql.param(col('reviewYn'))}::boolean[],
                        ${sql.param(col('reviewNote'))}::text[])
                 as u(domain_id, physical_nm, descr, suffix, domain_cls_id, col_type, col_length, col_scale,
                      review_yn, review_note)
           where d.domain_id = u.domain_id and d.project_id = ${projectId}`,
    );
  }
}
