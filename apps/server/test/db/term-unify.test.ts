import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TableSnapshot } from '@termflow/shared';
import { TermCacheRegistry } from '../../src/autocomplete/term-cache-registry.js';
import { audit } from '../../src/common/audit/audit.js';
import { createDb, type Db } from '../../src/db/client.js';
import {
  loadRmsRenamePairs,
  renameCounts,
  renderRenameBody,
  renderRenameSql,
  toOldModel,
} from '../../src/migration/cr09-rename-sql.js';
import { runRenameRegression } from '../../src/migration/ddl-regression.js';
import { parseSteps, type RunSummary } from '../../src/migration/runner.js';
import { TableService } from '../../src/table/table.service.js';
import { createMigratedDatabase } from './setup/databases.js';
import { insertUsers, runSteps, tempReportRoot } from './setup/stdv1.js';

/**
 * CR-09 용어 기준 물리명 정정(R19: 마스터 MAST · 등록자 RGSRT). `pnpm test:db -- term-unify`
 *  1) 새 적재(러너 1~13): DEFAULT_COL·TABLE이 처음부터 새 이름 → TERM_UNIFY 대상 없음(멱등), 대사 OK, DDL 회귀 33/33
 *  2) 운영 전환 스크립트 `docs/cr09_rename_postgresql.sql` = 생성기 결과, 이전 DDL 33개 → 스크립트 → 새 DDL과 카탈로그 일치(옵션 2)
 *  3) CR-09 이전 상태(이전 이름으로 적재된 DB)를 재현 → TERM_UNIFY가 서비스 경로로 정정(version+1·이력·감사·FINAL 유지)
 *     → 다시 실행하면 0건 → 이력 v1에서 이전 이름으로 복원 가능
 */
const DOC_SQL = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/cr09_rename_postgresql.sql',
);
const OLD = ['FIRS_REG_USER_ID', 'FINA_REG_USER_ID'];
const NEW = ['FIRS_RGSRT_ID', 'FINA_RGSRT_ID'];

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
const csvRows = (s: RunSummary, file: string) =>
  readFileSync(path.join(s.reportDir, `${file}.csv`), 'utf8')
    .replace(String.fromCharCode(0xfeff), '')
    .trimEnd()
    .split('\r\n')
    .slice(1)
    .filter((l) => l !== '')
    .map(parseCsvLine);

let pool: pg.Pool;
let db: Db;
let url: string;
let rmsId: number;
let first: RunSummary;
const rep = tempReportRoot('tf-cr09-');

beforeAll(async () => {
  url = await createMigratedDatabase('t_term_unify');
  pool = new pg.Pool({ connectionString: url, max: 4 });
  db = createDb(pool);
  await insertUsers(pool);
  first = await runSteps(
    { pool, db, url },
    rep.dir,
    'full',
    parseSteps('LOAD_LEGACY..DDL_REGRESSION'),
  );
  rmsId = (await pool.query("select project_id id from tf_project where project_key = 'RMS'"))
    .rows[0].id as number;
});
afterAll(async () => {
  await pool?.end();
  rep.cleanup();
});

const q1 = async <T>(text: string, params: unknown[] = []) =>
  (await pool.query(text, params)).rows[0] as T;

describe('새 적재 — R19 인라인(DEFAULT_COL·TABLE)', () => {
  it('러너 1~13 SUCCESS, TERM_UNIFY 대상 없음, 대사 OK, DDL 회귀 33/33', () => {
    expect(first.ok).toBe(true);
    expect(first.steps.map((s) => s.step)).toHaveLength(13);
    expect(first.steps.every((s) => s.status === 'SUCCESS')).toBe(true);
    const unify = first.steps.find((s) => s.step === 'TERM_UNIFY')!;
    expect(unify.result).toMatchObject({ loaded: 0, flagged: 0 });
    expect(unify.message).toBe('정정 대상 없음(이미 용어 기준)');
    const dflt = first.steps.find((s) => s.step === 'DEFAULT_COL')!;
    expect(dflt.result?.rules).toContainEqual({
      rule: 'R19',
      source: 9,
      loaded: 2,
      excluded: 0,
      flagged: 0,
    });
    const table = first.steps.find((s) => s.step === 'TABLE')!;
    expect(table.result?.rules).toContainEqual({
      rule: 'R19',
      source: 33 + 649,
      loaded: 18 + 66,
      excluded: 0,
      flagged: 0,
    });
    expect(first.steps.find((s) => s.step === 'DDL_REGRESSION')!.result).toMatchObject({
      source: 33,
      loaded: 33,
      flagged: 0,
    });
    const rec = csvRows(first, 'reconcile');
    expect(rec.every((r) => r[7] === 'OK' || r[7] === 'N/A')).toBe(true);
  });

  it('RETAILV1·RMS 기본컬럼 = RGSRT, RMS 테이블 끝 조각 MAST 18 · MST 0, 등록자 컬럼 66이 기본컬럼에 연결', async () => {
    const d = await pool.query<{ project_key: string; physical_nm: string }>(
      `select p.project_key, c.physical_nm from std_default_col c join tf_project p on p.project_id = c.project_id
        where c.logical_nm like '%등록자ID' order by 1, 2`,
    );
    expect(d.rows).toEqual([
      { project_key: 'RETAILV1', physical_nm: 'FINA_RGSRT_ID' },
      { project_key: 'RETAILV1', physical_nm: 'FIRS_RGSRT_ID' },
      { project_key: 'RMS', physical_nm: 'FINA_RGSRT_ID' },
      { project_key: 'RMS', physical_nm: 'FIRS_RGSRT_ID' },
    ]);
    const t = await q1<{ n: number; mast: number; mst: number; v1: number; fin: number }>(
      `select count(*)::int n, count(*) filter (where table_nm like '%\\_MAST')::int mast,
              count(*) filter (where table_nm like '%\\_MST')::int mst,
              count(*) filter (where version = 1)::int v1, count(*) filter (where status = 'FINAL')::int fin
         from prj_table where project_id = $1`,
      [rmsId],
    );
    expect(t).toEqual({ n: 33, mast: 18, mst: 0, v1: 33, fin: 33 });
    expect(
      await q1(
        `select count(*)::int n, count(default_col_id)::int linked,
                count(*) filter (where match_type = 'DEFAULT')::int dflt
           from prj_column where project_id = $1 and physical_nm = any($2)`,
        [rmsId, NEW],
      ),
    ).toEqual({ n: 66, linked: 66, dflt: 66 });
    expect(
      await q1('select count(*)::int n from prj_column where physical_nm = any($1)', [OLD]),
    ).toEqual({ n: 0 });
    // R17 리포트·이력 MIGRATE 스냅샷도 새 이름
    const r17 = csvRows(first, 'r17_no_pk').map((r) => r[9]!.split(' ')[0]);
    expect(r17.sort()).toEqual(['RP_ELC_APV_MAST', 'RP_OPNN_EVL_STD_MAST', 'RP_RVSN_INSP_MAST']);
    const h = await q1<{ n: number }>(
      `select count(*)::int n from prj_table_history h join prj_table t on t.table_id = h.table_id
        where t.project_id = $1 and (h.snapshot::text like '%REG_USER_ID%' or h.snapshot->'table'->>'tableNm' like '%\\_MST')`,
      [rmsId],
    );
    expect(h.n).toBe(0);
  });

  it('리포트 cr09-rename-map.csv: 기본컬럼 2 + 테이블명 18 + 컬럼명 66(이전 → 이후)', () => {
    const rows = csvRows(first, 'cr09-rename-map');
    expect(rows).toHaveLength(2 + 18 + 66);
    expect(rows.every((r) => r[0] === 'R19' && r[8] === 'NORMALIZED')).toBe(true);
    const pick = (step: string, field: string) =>
      rows.filter((r) => r[1] === step && r[5] === field).map((r) => `${r[6]}>${r[7]}`);
    expect(pick('DEFAULT_COL', 'physical_nm').sort()).toEqual([
      'FINA_REG_USER_ID>FINA_RGSRT_ID',
      'FIRS_REG_USER_ID>FIRS_RGSRT_ID',
    ]);
    expect(pick('TABLE', 'table_nm')).toContain('RP_RSCH_PRJ_MST>RP_RSCH_PRJ_MAST');
    expect(pick('TABLE', 'physical_nm')).toHaveLength(66);
  });
});

describe('운영 DB 전환 스크립트(docs/cr09_rename_postgresql.sql)', () => {
  it('파일 = 생성기 결과(테이블 33 · 테이블명 18 · 컬럼명 66 · 제약명 PK 15 · CHECK 4)', async () => {
    const pairs = await loadRmsRenamePairs(db);
    expect(renameCounts(pairs)).toEqual({
      tables: 33,
      renamedTables: 18,
      columns: 66,
      pk: 15,
      ck: 4,
    });
    expect(readFileSync(DOC_SQL, 'utf8')).toBe(renderRenameSql(pairs));
  });

  it('이전 이름 DDL 33개 실행 → 스크립트 → 새 DDL과 카탈로그 일치(기본 · DROP+CHECK), 이전 이름 테이블 없음', async () => {
    const pairs = await loadRmsRenamePairs(db);
    const client = await pool.connect();
    try {
      const results = await runRenameRegression(
        client,
        pairs.map((p) => ({ oldModel: toOldModel(p), newModel: p.model })),
        renderRenameBody(pairs),
      );
      expect(results.filter((r) => !r.ok)).toEqual([]);
      expect(results).toHaveLength(66);
      // 스크립트가 없으면(이전 DDL 그대로) 새 모델과 맞지 않는다 — 대조가 실제로 이름을 본다
      const without = await runRenameRegression(
        client,
        pairs.map((p) => ({ oldModel: toOldModel(p), newModel: p.model })),
        'SELECT 1',
        { sets: { default: {} } },
      );
      expect(without.filter((r) => !r.ok)).toHaveLength(33);
    } finally {
      client.release();
    }
  });
});

describe('CR-09 이전 DB(이전 이름으로 적재됨) → TERM_UNIFY 정정', () => {
  let fix: RunSummary;
  let userTableId: number;

  beforeAll(async () => {
    // 이전 이름 재현: 기본컬럼(RETAILV1·RMS) · RMS 컬럼 · 테이블명 · 이력 스냅샷 + 사용자 테이블 1(legacy 아님)
    await pool.query(
      `update std_default_col set physical_nm = case physical_nm when 'FIRS_RGSRT_ID' then 'FIRS_REG_USER_ID'
          else 'FINA_REG_USER_ID' end where physical_nm = any($1)`,
      [NEW],
    );
    await pool.query(
      `update prj_column set physical_nm = case physical_nm when 'FIRS_RGSRT_ID' then 'FIRS_REG_USER_ID'
          else 'FINA_REG_USER_ID' end where project_id = $1 and physical_nm = any($2)`,
      [rmsId, NEW],
    );
    await pool.query(
      `update prj_table set table_nm = regexp_replace(table_nm, '_MAST$', '_MST')
        where project_id = $1 and legacy_table_id is not null`,
      [rmsId],
    );
    await pool.query(
      `update prj_table_history h
          set snapshot = replace(replace(regexp_replace(h.snapshot::text, '_MAST"', '_MST"', 'g'),
                         'FIRS_RGSRT_ID', 'FIRS_REG_USER_ID'), 'FINA_RGSRT_ID', 'FINA_REG_USER_ID')::jsonb
         from prj_table t where t.table_id = h.table_id and t.project_id = $1`,
      [rmsId],
    );
    const rp = await q1<{ id: number }>(
      "select biz_area_id id from prj_biz_area where project_id = $1 and biz_cd = 'RP'",
      [rmsId],
    );
    userTableId = (
      await q1<{ id: number }>(
        `insert into prj_table (project_id, biz_area_id, table_nm, table_logical_nm, created_by, updated_by)
         values ($1, $2, 'RP_USER_MST', '사용자마스터', 'editor', 'editor') returning table_id id`,
        [rmsId, rp.id],
      )
    ).id;
    await pool.query(
      `insert into prj_column (project_id, table_id, col_seq, logical_nm, physical_nm, data_type, data_length, created_by, updated_by)
       values ($1, $2, 1, '최초등록자ID', 'FIRS_REG_USER_ID', 'VARCHAR', 20, 'editor', 'editor')`,
      [rmsId, userTableId],
    );
    fix = await runSteps({ pool, db, url }, rep.dir, 'fix', parseSteps('TERM_UNIFY'));
  });

  it('TERM_UNIFY: 기본컬럼 4(RETAILV1 2 · RMS 2) · 테이블 33 저장(테이블명 18 · 컬럼명 66) · 사용자 테이블 REVIEW 1', () => {
    expect(fix.ok).toBe(true);
    const u = fix.steps[0]!;
    expect(u).toMatchObject({ step: 'TERM_UNIFY', status: 'SUCCESS' });
    expect(u.result).toMatchObject({ source: 4 + 18 + 66 + 1, loaded: 4 + 18 + 66, flagged: 1 });
    expect(u.message).toContain('RMS 테이블 33건 저장(테이블명 18 · 컬럼명 66)');
    const rows = csvRows(fix, 'cr09-rename-map');
    expect(rows.filter((r) => r[8] === 'NORMALIZED')).toHaveLength(4 + 18 + 66);
    expect(rows.filter((r) => r[8] === 'REVIEW').map((r) => r[2])).toEqual(['RMS/RP_USER_MST']);
  });

  it('편집기 저장 경로: RMS 33 테이블 v2 · FINAL 유지 · 이력 UPDATE(CR-09) · 감사 주체 admin, 사용자 테이블은 그대로', async () => {
    const t = await q1(
      `select count(*)::int n, count(*) filter (where version = 2)::int v2, count(*) filter (where status = 'FINAL')::int fin,
              count(*) filter (where updated_by = 'admin')::int by_admin,
              count(*) filter (where table_nm like '%\\_MAST')::int mast, count(*) filter (where table_nm like '%\\_MST')::int mst
         from prj_table where project_id = $1 and legacy_table_id is not null`,
      [rmsId],
    );
    expect(t).toEqual({ n: 33, v2: 33, fin: 33, by_admin: 33, mast: 18, mst: 0 });
    const h = await pool.query<{
      action: string;
      change_summary: string;
      saved_by: string;
      snapshot: TableSnapshot;
    }>(
      `select h.action, h.change_summary, h.saved_by, h.snapshot from prj_table_history h
         join prj_table t on t.table_id = h.table_id
        where t.project_id = $1 and t.table_nm = 'RP_RSCH_PRJ_MAST' order by h.version`,
      [rmsId],
    );
    expect(h.rows.map((r) => r.action)).toEqual(['MIGRATE', 'UPDATE']);
    expect(h.rows[1]!.change_summary).toMatch(/^CR-09 용어 기준 정정\(R19\) · /);
    expect(h.rows[1]!.saved_by).toBe('admin');
    expect(h.rows[1]!.snapshot.note).toBe(
      'CR-09 용어 기준 정정(R19): 테이블 RP_RSCH_PRJ_MST → RP_RSCH_PRJ_MAST, FIRS_REG_USER_ID → FIRS_RGSRT_ID, FINA_REG_USER_ID → FINA_RGSRT_ID',
    );
    expect(h.rows[0]!.snapshot.table.tableNm).toBe('RP_RSCH_PRJ_MST');
    expect(h.rows[1]!.snapshot.table).toMatchObject({
      tableNm: 'RP_RSCH_PRJ_MAST',
      status: 'FINAL',
      version: 2,
    });
    const cols = await q1(
      `select count(*) filter (where physical_nm = any($2))::int new, count(*) filter (where physical_nm = any($3))::int old
         from prj_column where project_id = $1 and table_id <> $4`,
      [rmsId, NEW, OLD, userTableId],
    );
    expect(cols).toEqual({ new: 66, old: 0 });
    expect(
      await q1('select physical_nm from prj_column where table_id = $1', [userTableId]),
    ).toEqual({ physical_nm: 'FIRS_REG_USER_ID' });
    expect(
      await q1(
        `select count(*)::int n, count(*) filter (where actor = 'admin')::int by_admin from std_audit_log
          where entity_type = 'DEFAULT_COL' and action = 'UPDATE'`,
      ),
    ).toEqual({ n: 4, by_admin: 4 });
    expect(
      await q1('select count(*)::int n from std_default_col where physical_nm = any($1)', [OLD]),
    ).toEqual({ n: 0 });
  });

  it('다시 실행하면 정정 0건(멱등), 대사 OK · DDL 회귀 33/33(검증용 사용자 테이블은 지운 뒤)', async () => {
    await pool.query('delete from prj_table where table_id = $1', [userTableId]);
    const again = await runSteps(
      { pool, db, url },
      rep.dir,
      'again',
      parseSteps('TERM_UNIFY,RECONCILE,DDL_REGRESSION'),
    );
    expect(again.ok).toBe(true);
    expect(again.steps.map((s) => [s.step, s.status])).toEqual([
      ['TERM_UNIFY', 'SUCCESS'],
      ['RECONCILE', 'SUCCESS'],
      ['DDL_REGRESSION', 'SUCCESS'],
    ]);
    expect(again.steps[0]!.result).toMatchObject({ loaded: 0, flagged: 0 });
    expect(again.steps[0]!.message).toBe('정정 대상 없음(이미 용어 기준)');
    expect(again.steps[2]!.result).toMatchObject({ source: 33, loaded: 33, flagged: 0 });
    expect(
      await q1(
        `select count(*) filter (where version = 2)::int v2 from prj_table where project_id = $1 and legacy_table_id is not null`,
        [rmsId],
      ),
    ).toEqual({ v2: 33 });
  });

  it('이전 이름으로 복원 가능: 확정 해제 → 이력 v1 복원 → RP_RSCH_PRJ_MST · FIRS_REG_USER_ID', async () => {
    const cache = new TermCacheRegistry(db);
    try {
      const svc = new TableService(db, cache);
      const id = (
        await q1<{ id: number }>(
          "select table_id id from prj_table where table_nm = 'RP_RSCH_PRJ_MAST'",
        )
      ).id;
      const ctx = {
        projectId: rmsId,
        projectKey: 'RMS',
        kind: 'PROJECT' as const,
        status: 'ACTIVE' as const,
        role: 'ADMIN' as const,
        sysAdmin: true,
      };
      const a = audit('admin');
      const un = await svc.setStatus(
        ctx,
        id,
        { status: 'DRAFT', version: 2, note: '복원 확인' },
        a,
      );
      const r = await svc.restore(ctx, id, 1, un.version, a);
      expect(r.version).toBe(4);
      const d = await svc.detail(ctx, id);
      expect(d.table.tableNm).toBe('RP_RSCH_PRJ_MST');
      expect(d.columns.filter((c) => OLD.includes(c.physicalNm))).toHaveLength(2);
    } finally {
      cache.stopSweeper();
    }
  });
});
