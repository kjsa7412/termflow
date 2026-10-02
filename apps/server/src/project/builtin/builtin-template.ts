import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { StdType } from '@termflow/shared';
import { calculateDomain } from '../../autocomplete/domain-calculator.js';
import { SYSTEM_AUDIT } from '../../common/audit/audit.js';
import { insertAudited, updateAudited } from '../../db/audit.js';
import type { Db } from '../../db/client.js';
import {
  migrationLog,
  prjBizArea,
  stdCode,
  stdCodeCls,
  stdDefaultCol,
  stdDefaultColSet,
  stdDomain,
  stdDomainCls,
  stdTerm,
  tfProject,
} from '../../db/schema.js';
import { writeStdAudit } from '../../standard/std-audit.js';
import { readTemplate, templateDir, type TemplateData } from './template-files.js';
import { checkTemplate } from './template-quality.js';

/**
 * 동봉 기본 표준 템플릿(CR-16 C1·C4). 스키마 마이그레이션 직후(앱 기동·러너 CLI) 한 번 부른다.
 * ① 옛 승계 템플릿(키 STDV1, created_by MIGRATION)을 패션·유통 템플릿 RETAILV1로 키·이름을 바꾸고
 * ② 범용 기본 표준 STDV1을 동봉 CSV에서 한 트랜잭션으로 적재한다. 적재 기록(`migration_log` step BUILTIN_TEMPLATE)이
 * 있으면 다시 만들지 않는다(관리자가 지운 경우 포함).
 */

/** 범용 기본 표준(CR-16 C1). 마법사 기본값. */
export const BUILTIN_STD = {
  key: 'STDV1',
  nm: 'TermFlow 기본 표준 v1',
  description:
    '범용 기본 표준 — 공통·시스템·인사·회계·예산·계약·전자결재·영업·구매·재고 업무구분과 정제한 표준 사전·코드',
} as const;

/** 승계 러너가 만드는 패션·유통 템플릿(CR-16 C1·C2). */
export const RETAIL_TEMPLATE = {
  key: 'RETAILV1',
  nm: '패션·유통 표준 v1',
  description: '승계 원본(dump-gen_table-new.sql) — 패션·유통 용어·도메인과 이관 업무구분·코드',
} as const;

export const BUILTIN_STEP = 'BUILTIN_TEMPLATE';
const LOCK_KEY = 7_418_209_016;
const CHUNK = 500;

export interface PrepareResult {
  renamed: boolean;
  seeded: 'SEEDED' | 'ALREADY' | 'KEY_TAKEN';
  counts?: Record<string, number>;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

async function chunked<T>(rows: T[], run: (part: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) await run(rows.slice(i, i + CHUNK));
}

/** 옛 승계 STDV1 → RETAILV1(시스템 업그레이드 1회, CR-16 C5). */
async function renameLegacy(tx: Tx, log: (m: string) => void): Promise<boolean> {
  const [legacy] = await tx
    .select({ id: tfProject.projectId })
    .from(tfProject)
    .where(
      and(
        eq(tfProject.projectKey, BUILTIN_STD.key),
        eq(tfProject.kind, 'TEMPLATE'),
        eq(tfProject.createdBy, 'MIGRATION'),
      ),
    );
  if (!legacy) return false;
  const [taken] = await tx
    .select({ id: tfProject.projectId })
    .from(tfProject)
    .where(eq(tfProject.projectKey, RETAIL_TEMPLATE.key));
  if (taken) {
    log(
      `옛 승계 템플릿 ${BUILTIN_STD.key}를 ${RETAIL_TEMPLATE.key}로 바꾸지 못했습니다 — 키가 이미 있습니다`,
    );
    return false;
  }
  await updateAudited(
    tx,
    tfProject,
    {
      projectKey: RETAIL_TEMPLATE.key,
      projectNm: RETAIL_TEMPLATE.nm,
      description: RETAIL_TEMPLATE.description,
    },
    SYSTEM_AUDIT,
  ).where(eq(tfProject.projectId, legacy.id));
  log(`옛 승계 템플릿 ${BUILTIN_STD.key} → ${RETAIL_TEMPLATE.key} "${RETAIL_TEMPLATE.nm}"`);
  return true;
}

/** CSV 데이터를 새 템플릿 프로젝트로 넣는다. 도메인은 L1으로 다시 계산해 CSV 값과 같아야 한다. */
export async function insertTemplate(
  tx: Tx,
  data: TemplateData,
  target: { key: string; nm: string; description: string },
): Promise<{ projectId: number; counts: Record<string, number> }> {
  const a = SYSTEM_AUDIT;
  const [p] = await insertAudited(
    tx,
    tfProject,
    {
      projectKey: target.key,
      projectNm: target.nm,
      description: target.description,
      kind: 'TEMPLATE',
      status: 'ACTIVE',
      defaultDialect: 'POSTGRESQL',
    },
    a,
  ).returning({ id: tfProject.projectId });
  const projectId = p!.id;

  const biz = await insertAudited(
    tx,
    prjBizArea,
    data.bizAreas.map((b) => ({
      projectId,
      bizCd: b.bizCd,
      bizNm: b.bizNm,
      tablePrefix: b.tablePrefix,
      sortNo: b.sortNo,
      description: b.description,
    })),
    a,
  ).returning({ id: prjBizArea.bizAreaId, cd: prjBizArea.bizCd });
  const bizId = new Map(biz.map((b) => [b.cd, b.id]));

  await chunked(data.terms, (part) =>
    insertAudited(
      tx,
      stdTerm,
      part.map((t) => ({
        projectId,
        termKor: t.termKor,
        termPhysical: t.termPhysical,
        description: t.description,
        synonymRef: t.synonymRef === '' ? null : t.synonymRef,
        status: 'APPROVED',
      })),
      a,
    ),
  );

  const cls = await insertAudited(
    tx,
    stdDomainCls,
    data.domainClasses.map((c) => ({
      projectId,
      suffix: c.suffix,
      clsNm: c.clsNm,
      colType: c.colType,
      colLength: c.colLength,
      colScale: c.colScale,
      description: c.description,
    })),
    a,
  ).returning({ id: stdDomainCls.domainClsId, suffix: stdDomainCls.suffix });
  const clsId = new Map(cls.map((c) => [c.suffix, c.id]));

  const snap = {
    termByKor: new Map(data.terms.map((t) => [t.termKor, { physical: t.termPhysical }])),
    clsBySuffix: new Map(
      data.domainClasses.map((c) => [
        c.suffix,
        {
          domainClsId: clsId.get(c.suffix) ?? null,
          colType: c.colType as StdType,
          colLength: c.colLength,
          colScale: c.colScale,
        },
      ]),
    ),
  };
  const domainRows = data.domains.map((d) => {
    const r = calculateDomain({ parts: d.parts }, snap);
    if (r.notFound.length > 0 || r.physicalNm !== d.physicalNm || r.typeText !== d.typeText) {
      throw new Error(`템플릿 도메인 ${d.logicalNm}: 계산 결과가 CSV와 다릅니다`);
    }
    return {
      projectId,
      nm1: r.parts[0]!,
      nm2: r.parts[1] ?? null,
      nm3: r.parts[2] ?? null,
      nm4: r.parts[3] ?? null,
      nm5: r.parts[4] ?? null,
      nm6: r.parts[5] ?? null,
      nm7: r.parts[6] ?? null,
      logicalNm: r.logicalNm,
      physicalNm: r.physicalNm,
      descr: r.descr,
      suffix: r.suffix,
      domainClsId: r.domainClsId,
      colType: r.colType,
      colLength: r.colLength,
      colScale: r.colScale,
      typeSource: 'AUTO',
    };
  });
  await chunked(domainRows, (part) => insertAudited(tx, stdDomain, part, a));

  const classKeys = [...new Map(data.codes.map((c) => [`${c.bizCd}/${c.codeCls}`, c])).values()];
  const codeCls = await insertAudited(
    tx,
    stdCodeCls,
    classKeys.map((c) => ({
      projectId,
      bizAreaId: bizId.get(c.bizCd)!,
      codeCls: c.codeCls,
      codeClsNm: c.codeClsNm,
      description: c.codeClsDesc,
    })),
    a,
  ).returning({ id: stdCodeCls.codeClsId, biz: stdCodeCls.bizAreaId, cls: stdCodeCls.codeCls });
  const clsKeyId = new Map(codeCls.map((c) => [`${c.biz}/${c.cls}`, c.id]));
  await chunked(data.codes, (part) =>
    insertAudited(
      tx,
      stdCode,
      part.map((c) => ({
        projectId,
        codeClsId: clsKeyId.get(`${bizId.get(c.bizCd)}/${c.codeCls}`)!,
        code: c.code,
        codeNm: c.codeNm,
        sortOrder: c.sortOrder,
      })),
      a,
    ),
  );

  const setNames = [...new Map(data.defaultCols.map((c) => [c.setNm, c])).values()];
  const sets = await insertAudited(
    tx,
    stdDefaultColSet,
    setNames.map((s) => ({
      projectId,
      setNm: s.setNm,
      description: s.setDesc,
      isDefault: s.isDefault,
    })),
    a,
  ).returning({
    id: stdDefaultColSet.setId,
    nm: stdDefaultColSet.setNm,
    def: stdDefaultColSet.isDefault,
  });
  const setId = new Map(sets.map((s) => [s.nm, s.id]));
  await insertAudited(
    tx,
    stdDefaultCol,
    data.defaultCols.map((c) => ({
      projectId,
      setId: setId.get(c.setNm)!,
      colSeq: c.colSeq,
      logicalNm: c.logicalNm,
      physicalNm: c.physicalNm,
      isPk: c.isPk,
      dataType: c.dataType,
      dataLength: c.dataLength,
      dataScale: c.dataScale,
      isNullable: c.isPk ? false : c.isNullable,
      defaultVal: c.defaultVal,
      colComment: c.colComment,
    })),
    a,
  );
  const defaultSet = sets.find((s) => s.def);
  if (defaultSet) {
    await updateAudited(tx, tfProject, { defaultColSetId: defaultSet.id }, a).where(
      eq(tfProject.projectId, projectId),
    );
  }

  const counts = {
    BIZ_AREA: data.bizAreas.length,
    TERM: data.terms.length,
    DOMAIN_CLS: data.domainClasses.length,
    DOMAIN: data.domains.length,
    CODE_CLS: classKeys.length,
    CODE: data.codes.length,
    DEFAULT_COL_SET: setNames.length,
    DEFAULT_COL: data.defaultCols.length,
  };
  const batchId = randomUUID();
  await writeStdAudit(
    tx,
    Object.entries(counts).map(([entityType, n]) => ({
      projectId,
      entityType: entityType as keyof typeof counts,
      entityId: projectId,
      action: 'IMPORT' as const,
      after: { source: `resources/templates/${target.key.toLowerCase()}`, count: n },
      batchId,
    })),
    a,
  );
  return { projectId, counts };
}

/**
 * 기동 시 템플릿 준비(CR-16 C4). 실패해도 앱 기동은 막지 않도록 호출자가 오류를 기록만 한다.
 * `opts.dir`(CSV 폴더)는 테스트에서 바꿔 쓴다.
 */
export async function prepareTemplates(
  db: Db,
  log: (m: string) => void,
  opts: { dir?: string } = {},
): Promise<PrepareResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_KEY})`);
    const renamed = await renameLegacy(tx, log);

    const [done] = await tx
      .select({ id: migrationLog.migrationId })
      .from(migrationLog)
      .where(and(eq(migrationLog.step, BUILTIN_STEP), eq(migrationLog.status, 'SUCCESS')));
    if (done) return { renamed, seeded: 'ALREADY' };

    const [taken] = await tx
      .select({ id: tfProject.projectId })
      .from(tfProject)
      .where(eq(tfProject.projectKey, BUILTIN_STD.key));
    if (taken) {
      log(`기본 표준 ${BUILTIN_STD.key}를 만들지 않았습니다 — 같은 키의 프로젝트가 이미 있습니다`);
      return { renamed, seeded: 'KEY_TAKEN' };
    }

    const data = readTemplate(opts.dir ?? templateDir(BUILTIN_STD.key));
    const violations = checkTemplate(data);
    if (violations.length > 0) {
      throw new Error(
        `기본 표준 템플릿 품질 검사 위반 ${violations.length}건: ${violations
          .slice(0, 3)
          .map((x) => `${x.rule} ${x.target} ${x.message}`)
          .join(' / ')}`,
      );
    }
    const { counts } = await insertTemplate(tx, data, BUILTIN_STD);
    const total = Object.values(counts).reduce((s, n) => s + n, 0);
    await tx.insert(migrationLog).values({
      runId: randomUUID(),
      step: BUILTIN_STEP,
      sourceCnt: total,
      loadedCnt: total,
      status: 'SUCCESS',
      message: `${BUILTIN_STD.key} ${Object.entries(counts)
        .map(([k, n]) => `${k} ${n}`)
        .join(' · ')}`,
      finishedAt: sql`CURRENT_TIMESTAMP`,
    });
    log(
      `기본 표준 ${BUILTIN_STD.key} 적재 — 업무구분 ${counts.BIZ_AREA} · 용어 ${counts.TERM} · 도메인분류 ${counts.DOMAIN_CLS} · 도메인 ${counts.DOMAIN} · 코드구분 ${counts.CODE_CLS} · 코드 ${counts.CODE} · 기본컬럼 ${counts.DEFAULT_COL}`,
    );
    return { renamed, seeded: 'SEEDED', counts };
  });
}
