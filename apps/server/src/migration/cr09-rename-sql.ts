import { sql } from 'drizzle-orm';
import { constraintName } from '../ddl/dialect.js';
import type { TableModel } from '../ddl/model.js';
import type { Db } from '../db/client.js';
import { loadTableModels } from '../table/table-model.loader.js';
import { RMS, type Tx } from './context.js';
import { planRenames, type RenameTable } from './rules/r19-term-unify.js';

/**
 * CR-09 운영 DB 전환 스크립트(`docs/cr09_rename_postgresql.sql`) 생성기. **이전 이름으로 이미 만든** PostgreSQL 테이블
 * (RMS 승계 33 테이블의 DDL을 CR-09 이전에 실행한 DB)을 새 이름으로 바꾼다:
 *  - `ALTER TABLE … RENAME TO …`(끝 조각 MST → MAST), `ALTER TABLE … RENAME COLUMN …`(FIRS/FINA_REG_USER_ID → …_RGSRT_ID)
 *  - TermFlow DDL이 만든 제약 이름(PK_{테이블}, CHECK 방식이면 CK_{테이블}_{컬럼})도 새 DDL과 같게 — 있을 때만(DO 블록)
 * 식별자는 TermFlow 기본 출력과 같이 비인용 대문자(§6.4 D15: 카탈로그에는 소문자). 한 트랜잭션(BEGIN … COMMIT).
 * 이름 대응은 legacy 원본 이름 → R19(단일 원천 `r19-term-unify.ts`), 제약 이름은 DDL 생성기의 `constraintName`(63자 규칙)으로 계산한다.
 */
export interface RenamePair {
  plan: RenameTable;
  /** 새 이름 모델(정정 후 RMS). */
  model: TableModel;
}

/** legacy 원본 테이블·컬럼 이름 → R19 계획(바뀌는 테이블만, 원본 이름 순). */
export async function loadLegacyRenamePlan(q: Db | Tx): Promise<RenameTable[]> {
  const t = await q.execute(
    sql`select upper(trim(t.table_nm)) table_nm,
               array(select upper(trim(c.physical_col_nm)) from legacy.tb_column_schema c
                      where c.table_id = t.table_id order by c.col_seq) cols
          from legacy.tb_table_schema t order by upper(trim(t.table_nm)) collate "C"`,
  );
  return planRenames(
    (t.rows as { table_nm: string; cols: string[] }[]).map((r) => ({
      tableNm: r.table_nm,
      columns: r.cols,
    })),
  );
}

/** 계획 + 새 모델 짝(모델이 없으면 실패 — 정정 전 DB이거나 테이블이 삭제됨). */
export function pairPlans(plan: readonly RenameTable[], models: readonly TableModel[]): RenamePair[] {
  const byNm = new Map(models.map((m) => [m.tableNm, m]));
  return plan.map((p) => {
    const model = byNm.get(p.newNm);
    if (!model) throw new Error(`새 이름 테이블이 없습니다: ${p.newNm}(이전 ${p.oldNm}) — TERM_UNIFY 정정 후 생성하십시오`);
    for (const c of p.columns) {
      if (!model.columns.some((x) => x.physicalNm === c.newNm))
        throw new Error(`새 이름 컬럼이 없습니다: ${p.newNm}.${c.newNm}`);
    }
    return { plan: p, model };
  });
}

/** DB(legacy 스키마 + 정정 후 RMS)에서 짝 목록. CLI·검증 테스트 공용. */
export async function loadRmsRenamePairs(db: Db): Promise<RenamePair[]> {
  const plan = await loadLegacyRenamePlan(db);
  const [p] = (
    await db.execute(sql`select project_id from tf_project where project_key = ${RMS.key}`)
  ).rows as { project_id: number }[];
  if (!p) throw new Error(`프로젝트 ${RMS.key}가 없습니다`);
  const ids = (
    await db.execute(
      sql`select table_id from prj_table where project_id = ${p.project_id} and legacy_table_id is not null`,
    )
  ).rows as { table_id: number }[];
  const models = await loadTableModels(
    db,
    p.project_id,
    ids.map((r) => r.table_id),
  );
  return pairPlans(plan, models);
}

/** 새 모델 → 이전 이름 모델(검증용: CR-09 이전 DDL). */
export function toOldModel(pair: RenamePair): TableModel {
  const back = new Map(pair.plan.columns.map((c) => [c.newNm, c.oldNm]));
  return {
    ...pair.model,
    tableNm: pair.plan.oldNm,
    columns: pair.model.columns.map((c) => ({ ...c, physicalNm: back.get(c.physicalNm) ?? c.physicalNm })),
  };
}

/** 이 테이블에서 이름이 바뀌는 제약(PK·CHECK) — 이전·이후 이름(대문자, 비인용 → 카탈로그 소문자). */
export function constraintRenames(pair: RenamePair): { kind: 'PK' | 'CK'; oldNm: string; newNm: string }[] {
  const { plan, model } = pair;
  if (plan.oldNm === plan.newNm && plan.columns.length === 0) return [];
  const back = new Map(plan.columns.map((c) => [c.newNm, c.oldNm]));
  const out: { kind: 'PK' | 'CK'; oldNm: string; newNm: string }[] = [];
  if (model.columns.some((c) => c.isPk)) {
    const o = constraintName('PK', plan.oldNm, 63).name;
    const n = constraintName('PK', plan.newNm, 63).name;
    if (o !== n) out.push({ kind: 'PK', oldNm: o, newNm: n });
  }
  for (const c of model.columns) {
    if (!c.codeClsRef || c.codeClsRef.codes.length === 0) continue;
    const o = constraintName('CK', `${plan.oldNm}_${back.get(c.physicalNm) ?? c.physicalNm}`, 63).name;
    const n = constraintName('CK', `${plan.newNm}_${c.physicalNm}`, 63).name;
    if (o !== n) out.push({ kind: 'CK', oldNm: o, newNm: n });
  }
  return out;
}

const lit = (s: string) => `'${s.toLowerCase()}'`;

/** 테이블 1개의 문장들(트랜잭션 제어 없음). */
function tableStatements(pair: RenamePair): string[] {
  const { plan, model } = pair;
  const lines: string[] = [`-- ${plan.oldNm} → ${plan.newNm} (${model.logicalNm})`];
  if (plan.oldNm !== plan.newNm) lines.push(`ALTER TABLE ${plan.oldNm} RENAME TO ${plan.newNm};`);
  for (const c of plan.columns)
    lines.push(`ALTER TABLE ${plan.newNm} RENAME COLUMN ${c.oldNm} TO ${c.newNm};`);
  const cons = constraintRenames(pair);
  if (cons.length > 0) {
    lines.push('DO $$', 'BEGIN');
    for (const k of cons) {
      lines.push(
        `  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = ${lit(plan.newNm)}::regclass AND conname = ${lit(k.oldNm)}) THEN`,
        `    ALTER TABLE ${plan.newNm} RENAME CONSTRAINT ${k.oldNm} TO ${k.newNm};`,
        '  END IF;',
      );
    }
    lines.push('END $$;');
  }
  return lines;
}

/** 본문(트랜잭션 제어 없음) — 검증 테스트는 이것을 자기 트랜잭션 안에서 실행한다. */
export function renderRenameBody(pairs: readonly RenamePair[]): string {
  return pairs.map((p) => tableStatements(p).join('\n')).join('\n\n') + '\n';
}

export function renameCounts(pairs: readonly RenamePair[]): {
  tables: number;
  renamedTables: number;
  columns: number;
  pk: number;
  ck: number;
} {
  const cons = pairs.flatMap(constraintRenames);
  return {
    tables: pairs.length,
    renamedTables: pairs.filter((p) => p.plan.oldNm !== p.plan.newNm).length,
    columns: pairs.reduce((n, p) => n + p.plan.columns.length, 0),
    pk: cons.filter((k) => k.kind === 'PK').length,
    ck: cons.filter((k) => k.kind === 'CK').length,
  };
}

/** 파일 전체(머리말 + BEGIN + 본문 + COMMIT). 생성 시각을 넣지 않는다(같은 입력 = 같은 파일, 테스트가 문자열 비교). */
export function renderRenameSql(pairs: readonly RenamePair[]): string {
  const n = renameCounts(pairs);
  const head = [
    '-- =====================================================================',
    '-- docs/cr09_rename_postgresql.sql — CR-09 용어 기준 물리명 정정(R19) 운영 DB 전환 스크립트(PostgreSQL)',
    '-- 생성: pnpm --filter @termflow/server cr09:sql (정정 후 dev DB의 legacy 원본 이름 + RMS 모델에서). 직접 수정 금지',
    '-- 대상: CR-09 이전 이름(테이블 끝 _MST, 컬럼 FIRS/FINA_REG_USER_ID)으로 TermFlow DDL을 이미 실행한 DB',
    `-- 내용: 테이블 ${n.tables}개 — 테이블명 ${n.renamedTables}(MST → MAST) · 컬럼명 ${n.columns}(REG_USER_ID → RGSRT_ID) · 제약명 PK ${n.pk}` +
      (n.ck > 0 ? ` · CHECK ${n.ck}` : '') +
      '(있을 때만)',
    '-- 전제: 비인용 식별자(TermFlow 기본 출력, 카탈로그 소문자) · search_path에 대상 스키마 · 한 트랜잭션(하나라도 실패하면 전부 취소)',
    '-- 검증: pnpm test:db -- term-unify (이전 DDL 33개 실행 → 이 스크립트 → 새 DDL과 카탈로그 대조, 기본·DROP+CHECK)',
    '-- =====================================================================',
    '',
    'BEGIN;',
    '',
  ];
  return `${head.join('\n')}${renderRenameBody(pairs)}\nCOMMIT;\n`;
}
