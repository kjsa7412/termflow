import { sql } from 'drizzle-orm';
import type { ColumnInput, DefaultColInput, ProjectKind, ProjectStatus, StdType } from '@termflow/shared';
import { TermCacheRegistry } from '../../autocomplete/term-cache-registry.js';
import { audit, type Audit } from '../../common/audit/audit.js';
import type { ProjectCtx } from '../../common/project-context.js';
import { rowsOf } from '../../project/sql-util.js';
import { DefaultColService } from '../../standard/default-col.service.js';
import { StdWriter } from '../../standard/std-write.js';
import { loadColumns, loadHeader, toExisting } from '../../table/table-detail.loader.js';
import { TableService } from '../../table/table.service.js';
import { RMS, StepFailure, type StepContext, type StepDef } from '../context.js';
import type { ReportRow } from '../report-writer.js';
import {
  planRenames,
  R19_COLUMN_RENAMES,
  R19_REPORT,
  R19_RULE,
  r19ColumnName,
} from '../rules/r19-term-unify.js';

/**
 * TERM_UNIFY(CR-09, R19): **이미 적재된 DB**의 물리명을 용어사전 기준으로 정정한다(새 적재는 DEFAULT_COL·TABLE이 처음부터 R19 적용).
 *  1. 기본컬럼 세트(모든 프로젝트·템플릿): `FIRS/FINA_REG_USER_ID` → `FIRS/FINA_RGSRT_ID` — `DefaultColService.putColumns`
 *     (표준 쓰기 공통 경로: 행 유지(default_col_id 보존) · `std_audit_log` UPDATE · 캐시 무효화)
 *  2. RMS 승계 테이블(`legacy_table_id` 있음): 테이블명 끝 `MST` → `MAST`, 위 두 컬럼 이름 — `TableService.save`
 *     (편집기 저장과 같은 경로: 검증 · version+1 · 컬럼 diff · 스냅샷 이력 UPDATE · 감사 컬럼). FINAL은 유지(`allowFinal`)하고,
 *     이전 이름은 직전 버전 스냅샷에 남아 이력에서 복원할 수 있다(확정 해제 후 [복원])
 *  3. 그 밖의 테이블 컬럼(사용자 테이블)은 바꾸지 않고 리포트에 REVIEW로 남긴다(CR-09 §3)
 * 대상이 없으면 아무것도 쓰지 않는다(재실행 멱등). 주체 = `--rms-admin`(기본 부트스트랩 관리자, 관리자 정정 작업).
 * 트랜잭션은 서비스 호출 단위(세트 1개·테이블 1개) — 중간에 실패해도 다시 실행하면 남은 대상만 정정한다.
 */
const SUMMARY_PREFIX = 'CR-09 용어 기준 정정(R19)';
const OLD_COLS = [...R19_COLUMN_RENAMES.keys()];

interface ProjRow {
  project_id: number;
  project_key: string;
  kind: ProjectKind;
  status: ProjectStatus;
}

const ctxOf = (p: ProjRow): ProjectCtx => ({
  projectId: p.project_id,
  projectKey: p.project_key,
  kind: p.kind,
  status: p.status,
  role: 'ADMIN',
  sysAdmin: true,
});

export const termUnifyStep: StepDef = {
  name: 'TERM_UNIFY',
  skippable: false,
  transactional: false,
  isDone: () => Promise.resolve(false),
  async run(c) {
    c.report.declare(R19_REPORT);
    const actor = c.opts.rmsAdmin ?? 'admin';
    const [u] = await rowsOf<{ sa: boolean }>(
      c.db,
      sql`select is_sys_admin sa from tf_user where login_id = ${actor}`,
    );
    if (!u?.sa)
      throw new StepFailure(`정정 주체 ${actor}가 시스템 관리자가 아닙니다(--rms-admin으로 지정)`);
    const a = audit(actor);
    const cache = new TermCacheRegistry(c.db);
    try {
      const writer = new StdWriter(c.db, cache);
      const sets = await unifyDefaultCols(c, new DefaultColService(c.db, writer), a);
      const tables = await unifyTables(c, new TableService(c.db, cache), a);
      const review = await reportUserColumns(c);
      const loaded = sets.cols + tables.tables + tables.cols;
      return {
        source: sets.cols + tables.candidates + review,
        loaded,
        excluded: 0,
        flagged: review + sets.skipped + tables.skipped,
        rules: [
          {
            rule: R19_RULE,
            source: sets.cols + tables.candidates + review,
            loaded,
            excluded: 0,
            flagged: review + sets.skipped + tables.skipped,
          },
        ],
        message:
          loaded === 0 && review === 0
            ? '정정 대상 없음(이미 용어 기준)'
            : `기본컬럼 ${sets.cols}(세트 ${sets.sets}) · RMS 테이블 ${tables.saved}건 저장(테이블명 ${tables.tables} · 컬럼명 ${tables.cols}) · ` +
              `건너뜀 ${sets.skipped + tables.skipped} · 사용자 테이블 컬럼(변경 안 함) ${review}`,
      };
    } finally {
      cache.stopSweeper();
    }
  },
};

function row(r: Omit<ReportRow, 'rule' | 'step'>): ReportRow {
  return { rule: R19_RULE, step: 'TERM_UNIFY', ...r };
}

async function unifyDefaultCols(
  c: StepContext,
  svc: DefaultColService,
  a: Audit,
): Promise<{ sets: number; cols: number; skipped: number }> {
  const targets = await rowsOf<ProjRow & { set_id: number; set_nm: string }>(
    c.db,
    sql`select distinct p.project_id, p.project_key, p.kind, p.status, s.set_id, s.set_nm
          from std_default_col d
          join std_default_col_set s on s.set_id = d.set_id
          join tf_project p on p.project_id = d.project_id
         where d.physical_nm = any(${sql.param(OLD_COLS)}::text[])
         order by p.kind desc, p.project_key, s.set_id`,
  );
  let sets = 0;
  let cols = 0;
  let skipped = 0;
  for (const t of targets) {
    const cur = await rowsOf<{
      default_col_id: number;
      logical_nm: string;
      physical_nm: string;
      is_pk: boolean;
      data_type: StdType;
      data_length: number | null;
      data_scale: number | null;
      is_nullable: boolean;
      default_val: string | null;
      col_comment: string | null;
    }>(
      c.db,
      sql`select default_col_id, logical_nm, physical_nm, is_pk, data_type, data_length, data_scale, is_nullable,
                 default_val, col_comment
            from std_default_col where set_id = ${t.set_id} order by col_seq`,
    );
    const key = `${t.project_key}/${t.set_nm}`;
    const names = new Set(cur.map((x) => x.physical_nm));
    const changes = cur.filter((x) => r19ColumnName(x.physical_nm) !== x.physical_nm);
    const clash = changes.filter((x) => names.has(r19ColumnName(x.physical_nm)));
    if (t.status === 'ARCHIVED' || clash.length > 0) {
      skipped += changes.length;
      for (const x of changes)
        c.report.add(
          R19_REPORT,
          row({
            legacyKey: key,
            targetTable: 'std_default_col',
            targetId: x.default_col_id,
            field: 'physical_nm',
            before: x.physical_nm,
            after: r19ColumnName(x.physical_nm),
            action: 'REVIEW',
            note: t.status === 'ARCHIVED' ? '보관 프로젝트 — 정정 안 함' : '세트에 같은 이름이 이미 있음 — 정정 안 함',
          }),
        );
      continue;
    }
    const input: DefaultColInput[] = cur.map((x) => ({
      defaultColId: x.default_col_id,
      logicalNm: x.logical_nm,
      physicalNm: r19ColumnName(x.physical_nm),
      isPk: x.is_pk,
      dataType: x.data_type,
      dataLength: x.data_length,
      dataScale: x.data_scale,
      isNullable: x.is_nullable,
      defaultVal: x.default_val,
      colComment: x.col_comment,
    }));
    await svc.putColumns(ctxOf(t), t.set_id, input, a);
    sets++;
    cols += changes.length;
    for (const x of changes)
      c.report.add(
        R19_REPORT,
        row({
          legacyKey: key,
          targetTable: 'std_default_col',
          targetId: x.default_col_id,
          field: 'physical_nm',
          before: x.physical_nm,
          after: r19ColumnName(x.physical_nm),
          action: 'NORMALIZED',
          note: `${t.kind === 'TEMPLATE' ? '템플릿' : '프로젝트'} ${t.project_key} 세트 ${t.set_nm}: ${x.logical_nm}`,
        }),
      );
    c.log(`[migrate:seed] TERM_UNIFY 기본컬럼 ${key}: ${changes.length}건`);
  }
  return { sets, cols, skipped };
}

async function unifyTables(
  c: StepContext,
  svc: TableService,
  a: Audit,
): Promise<{ candidates: number; saved: number; tables: number; cols: number; skipped: number }> {
  const [p] = await rowsOf<ProjRow>(
    c.db,
    sql`select project_id, project_key, kind, status from tf_project where project_key = ${RMS.key}`,
  );
  const out = { candidates: 0, saved: 0, tables: 0, cols: 0, skipped: 0 };
  if (!p) return out;
  const ctx = ctxOf(p);
  const tables = await rowsOf<{ table_id: number; table_nm: string; legacy_table_id: string }>(
    c.db,
    sql`select table_id, table_nm, legacy_table_id from prj_table
         where project_id = ${p.project_id} and legacy_table_id is not null order by table_nm`,
  );
  const allNames = new Set(
    (
      await rowsOf<{ table_nm: string }>(
        c.db,
        sql`select table_nm from prj_table where project_id = ${p.project_id}`,
      )
    ).map((r) => r.table_nm),
  );
  for (const t of tables) {
    const columns = await loadColumns(c.db, p.project_id, t.table_id);
    let plan;
    try {
      plan = planRenames([{ tableNm: t.table_nm, columns: columns.map((x) => x.physicalNm) }])[0];
    } catch (e) {
      out.skipped++;
      c.report.add(
        R19_REPORT,
        row({
          legacyKey: t.legacy_table_id,
          targetTable: 'prj_table',
          targetId: t.table_id,
          field: 'table_nm',
          before: t.table_nm,
          after: null,
          action: 'REVIEW',
          note: e instanceof Error ? e.message : String(e),
        }),
      );
      continue;
    }
    if (!plan) continue;
    out.candidates += (plan.newNm !== plan.oldNm ? 1 : 0) + plan.columns.length;
    if (plan.newNm !== plan.oldNm && allNames.has(plan.newNm)) {
      out.skipped++;
      c.report.add(
        R19_REPORT,
        row({
          legacyKey: t.legacy_table_id,
          targetTable: 'prj_table',
          targetId: t.table_id,
          field: 'table_nm',
          before: plan.oldNm,
          after: plan.newNm,
          action: 'REVIEW',
          note: '프로젝트에 같은 이름의 테이블이 있음 — 정정 안 함',
        }),
      );
      continue;
    }
    const header = (await loadHeader(c.db, p.project_id, p.project_key, t.table_id))!;
    const input: ColumnInput[] = columns.map((x) => ({
      ...toExisting(x),
      physicalNm: r19ColumnName(x.physicalNm),
    }));
    const note = [
      plan.newNm !== plan.oldNm ? `테이블 ${plan.oldNm} → ${plan.newNm}` : null,
      ...plan.columns.map((x) => `${x.oldNm} → ${x.newNm}`),
    ]
      .filter(Boolean)
      .join(', ');
    const r = await svc.save(
      ctx,
      t.table_id,
      {
        version: header.version,
        table: {
          bizAreaId: header.bizAreaId,
          tableNm: plan.newNm,
          tableLogicalNm: header.tableLogicalNm,
          description: header.description,
        },
        columns: input,
      },
      a,
      {
        action: 'UPDATE',
        summaryPrefix: SUMMARY_PREFIX,
        extra: { note: `${SUMMARY_PREFIX}: ${note}` },
        allowFinal: true,
      },
    );
    out.saved++;
    if (plan.newNm !== plan.oldNm) {
      out.tables++;
      allNames.delete(plan.oldNm);
      allNames.add(plan.newNm);
      c.report.add(
        R19_REPORT,
        row({
          legacyKey: t.legacy_table_id,
          targetTable: 'prj_table',
          targetId: t.table_id,
          field: 'table_nm',
          before: plan.oldNm,
          after: plan.newNm,
          action: 'NORMALIZED',
          note: `${RMS.key} v${header.version} → v${r.version}(${header.status})`,
        }),
      );
    }
    for (const x of plan.columns) {
      out.cols++;
      const col = columns.find((k) => k.physicalNm === x.oldNm)!;
      c.report.add(
        R19_REPORT,
        row({
          legacyKey: `${t.legacy_table_id}#${col.colSeq}`,
          targetTable: 'prj_column',
          targetId: col.columnId,
          field: 'physical_nm',
          before: x.oldNm,
          after: x.newNm,
          action: 'NORMALIZED',
          note: `${plan.newNm}.${x.newNm}`,
        }),
      );
    }
  }
  if (out.saved > 0) c.log(`[migrate:seed] TERM_UNIFY RMS 테이블 ${out.saved}건 저장`);
  return out;
}

/** RMS 승계 테이블이 아닌 테이블의 옛 기본컬럼 이름 컬럼(바꾸지 않음, CR-09 §3) → REVIEW. */
async function reportUserColumns(c: StepContext): Promise<number> {
  const rows = await rowsOf<{
    project_key: string;
    table_nm: string;
    column_id: number;
    physical_nm: string;
  }>(
    c.db,
    sql`select p.project_key, t.table_nm, k.column_id, k.physical_nm
          from prj_column k
          join prj_table t on t.table_id = k.table_id
          join tf_project p on p.project_id = t.project_id
         where k.physical_nm = any(${sql.param(OLD_COLS)}::text[])
           and not (p.project_key = ${RMS.key} and t.legacy_table_id is not null)
         order by p.project_key, t.table_nm, k.col_seq`,
  );
  for (const r of rows)
    c.report.add(
      R19_REPORT,
      row({
        legacyKey: `${r.project_key}/${r.table_nm}`,
        targetTable: 'prj_column',
        targetId: r.column_id,
        field: 'physical_nm',
        before: r.physical_nm,
        after: r19ColumnName(r.physical_nm),
        action: 'REVIEW',
        note: '사용자 테이블 — 정정 범위 밖(CR-09 §3), 필요하면 편집기에서 수정',
      }),
    );
  return rows.length;
}
