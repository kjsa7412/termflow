import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  DdlExtractResponse,
  DdlResponse,
  ExportLogItem,
  Page,
  ProblemDetail,
  SearchResponse,
  TablePage,
} from '@termflow/shared';
import { unzipText } from '../../src/ddl/zip.js';
import { GOLDEN_DIR } from '../unit/rp33.js';
import { Client, createTestApp, setTestEnv } from './setup/app.js';
import { FIXTURE_PASSWORD, useTestDb } from './setup/databases.js';
import { perfLimit } from './setup/perf.js';
import { insertUsers } from './setup/stdv1.js';

/**
 * 단계 7 API(T7.8·T7.9): 테이블 목록·단일 DDL·다중 DDL(JSON/SQL/ZIP)·정보 추출·내보내기 기록·전역 검색.
 * 데이터: `test/seed/rp33.sql`(승계 완료 RMS 33 테이블) + 교차 참조 확인용 다른 프로젝트 OTHR. `pnpm test:db -- ddl`
 */
const t = useTestDb('t_ddl_api', { fixture: 'rp33' });
let app: INestApplication;
const P = '/api/v1/projects/RMS';
let rmsId = 0;
let rpBizId = 0;
let acBizId = 0;
const tableId: Record<string, number> = {};
let other = { projectId: 0, bizAreaId: 0, tableId: 0 };

beforeAll(async () => {
  const users = await insertUsers(t.pool);
  const p = await t.pool.query<{ project_id: number }>(
    "select project_id from tf_project where project_key = 'RMS'",
  );
  rmsId = p.rows[0]!.project_id;
  for (const [login, role] of [
    ['pa', 'ADMIN'],
    ['editor', 'EDITOR'],
    ['viewer', 'VIEWER'],
  ] as const) {
    await t.pool.query(
      `insert into tf_project_member (project_id, user_id, member_role, created_by, updated_by)
       values ($1, $2, $3, 'SYSTEM', 'SYSTEM')`,
      [rmsId, users[login], role],
    );
  }
  const b = await t.pool.query<{ biz_cd: string; biz_area_id: number }>(
    'select biz_cd, biz_area_id from prj_biz_area where project_id = $1',
    [rmsId],
  );
  rpBizId = b.rows.find((r) => r.biz_cd === 'RP')!.biz_area_id;
  acBizId = b.rows.find((r) => r.biz_cd === 'AC')!.biz_area_id;
  const tb = await t.pool.query<{ table_nm: string; table_id: number }>(
    'select table_nm, table_id from prj_table where project_id = $1',
    [rmsId],
  );
  for (const r of tb.rows) tableId[r.table_nm] = r.table_id;
  // 다른 프로젝트(OTHR): 같은 이름의 업무구분·테이블 — RMS 요청에서 이 ID들은 404/422여야 한다
  const o = await t.pool.query<{ project_id: number }>(
    `insert into tf_project (project_key, project_nm, created_by, updated_by)
     values ('OTHR', '다른 프로젝트', 'SYSTEM', 'SYSTEM') returning project_id`,
  );
  const opid = o.rows[0]!.project_id;
  const ob = await t.pool.query<{ biz_area_id: number }>(
    `insert into prj_biz_area (project_id, biz_cd, biz_nm, table_prefix, created_by, updated_by)
     values ($1, 'RP', '연구과제', 'RP_', 'SYSTEM', 'SYSTEM') returning biz_area_id`,
    [opid],
  );
  const ot = await t.pool.query<{ table_id: number }>(
    `insert into prj_table (project_id, biz_area_id, table_nm, table_logical_nm, created_by, updated_by)
     values ($1, $2, 'RP_RSCH_PRJ_MAST', '다른 프로젝트 테이블', 'SYSTEM', 'SYSTEM') returning table_id`,
    [opid, ob.rows[0]!.biz_area_id],
  );
  other = { projectId: opid, bizAreaId: ob.rows[0]!.biz_area_id, tableId: ot.rows[0]!.table_id };
  setTestEnv(t.url);
  app = await createTestApp();
});
afterAll(async () => {
  await app?.close();
});

async function as(login: string): Promise<Client> {
  const c = new Client(app.getHttpServer());
  expect((await c.login(login, FIXTURE_PASSWORD)).status).toBe(200);
  return c;
}
const logs = async () =>
  (
    await t.pool.query<{ output_kind: string; table_cnt: number; exported_by: string }>(
      'select output_kind, table_cnt, exported_by from ddl_export_log order by export_id',
    )
  ).rows;
const golden = (set: string, name: string) =>
  readFileSync(path.join(GOLDEN_DIR, set, `${name}.sql`), 'utf8');
/** 헤더 첫 줄(생성 시각·생성자)만 다르다. */
const body = (sql: string) => sql.split('\n').slice(1).join('\n');

describe('테이블 목록 GET P/tables(T7.9)', () => {
  it('업무구분·검색·상태·정렬·페이지, bizAreaCounts·statusCounts, 재검증 경고 수', async () => {
    const v = await as('viewer');
    const r = await v.get(`${P}/tables?size=50&sort=tableNm,asc`);
    expect(r.status).toBe(200);
    const page = r.body as TablePage;
    expect(page.total).toBe(33);
    expect(page.allCnt).toBe(33);
    expect(page.bizAreaCounts).toEqual([{ bizAreaId: rpBizId, cnt: 33 }]);
    expect(page.statusCounts).toEqual({ DRAFT: 0, FINAL: 33 });
    expect(page.items.map((x) => x.tableNm)).toEqual(Object.keys(tableId).sort());
    const noPk = page.items.filter((x) => x.issues.some((i) => i.code === 'W_PK_NONE'));
    expect(noPk).toHaveLength(3);
    expect(page.items.every((x) => x.errorCnt === 0)).toBe(true);
    const mst = page.items.find((x) => x.tableNm === 'RP_RSCH_PRJ_MAST')!;
    expect(mst).toMatchObject({ bizCd: 'RP', status: 'FINAL', version: 1, updatedBy: 'MIGRATION' });
    expect(mst.colCnt).toBeGreaterThan(0);

    const q = (await v.get(`${P}/tables?q=${encodeURIComponent('연구과제')}`)).body as TablePage;
    expect(q.total).toBeGreaterThan(0);
    expect(
      q.items.every((x) => x.logicalNm.includes('연구과제') || x.tableNm.includes('연구과제')),
    ).toBe(true);
    expect(((await v.get(`${P}/tables?q=rsch_prj_mast`)).body as TablePage).total).toBe(1);
    const ac = (await v.get(`${P}/tables?bizAreaId=${acBizId}`)).body as TablePage;
    expect(ac.total).toBe(0);
    expect(ac.statusCounts).toEqual({ DRAFT: 0, FINAL: 0 });
    expect(ac.allCnt).toBe(33); // 좌측 건수는 업무구분 필터와 무관
    const draft = (await v.get(`${P}/tables?status=DRAFT`)).body as TablePage;
    expect(draft.total).toBe(0);
    expect(draft.statusCounts.FINAL).toBe(33); // 상태 세그먼트는 상태 필터와 무관
    const byCols = (await v.get(`${P}/tables?sort=colCnt,desc&size=5`)).body as TablePage;
    const cnts = byCols.items.map((x) => x.colCnt);
    expect(cnts).toEqual([...cnts].sort((a, b) => b - a));
    const p2 = (await v.get(`${P}/tables?size=20&page=2`)).body as TablePage;
    expect(p2.items).toHaveLength(13);
    expect((await v.get(`${P}/tables?sort=hack,asc`)).status).toBe(400);
  });

  it('20행 200ms 이내(RMS 기준, 20회 p95)', async () => {
    const v = await as('viewer');
    await v.get(`${P}/tables`);
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      expect((await v.get(`${P}/tables?size=20`)).status).toBe(200);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const p95 = times[18]!;
    console.log(
      `[test:db ddl] 테이블 목록 20행 p95 ${p95.toFixed(0)}ms (중앙값 ${times[10]!.toFixed(0)}ms)`,
    );
    expect(p95).toBeLessThan(perfLimit(200, 1500));
  });

  it('비멤버 404, 다른 프로젝트 테이블은 보이지 않는다', async () => {
    const n = await as('nobody');
    expect((await n.get(`${P}/tables`)).status).toBe(404);
    const v = await as('viewer');
    const all = (await v.get(`${P}/tables?size=100`)).body as TablePage;
    expect(all.items.some((x) => x.tableId === other.tableId)).toBe(false);
  });

  it('전역 검색에 테이블(물리명·논리명, 현재 프로젝트만)', async () => {
    const v = await as('viewer');
    const r = (await v.get(`${P}/search?q=RP_RSCH_PRJ_MAST`)).body as SearchResponse;
    expect(r.tables[0]).toEqual({
      tableId: tableId['RP_RSCH_PRJ_MAST'],
      tableNm: 'RP_RSCH_PRJ_MAST',
      logicalNm: expect.any(String),
      bizCd: 'RP',
    });
    expect(r.tables.some((x) => x.tableId === other.tableId)).toBe(false);
    const k = (await v.get(`${P}/search?q=${encodeURIComponent('마스터')}`)).body as SearchResponse;
    expect(k.tables.length).toBeGreaterThan(0);
    expect(k.tables.length).toBeLessThanOrEqual(5);
  });
});

describe('단일 DDL GET P/tables/{id}/ddl', () => {
  it('text/plain = 골든 파일(헤더 첫 줄 제외), 옵션 쿼리, format=json', async () => {
    const v = await as('viewer');
    const id = tableId['RP_RSCH_PRJ_MAST']!;
    const r = await v.get(`${P}/tables/${id}/ddl`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/plain; charset=utf-8/);
    expect(r.text.split('\n')[0]).toMatch(
      /^-- TermFlow DDL \| 프로젝트 RMS 연구관리시스템\(이관\) · 업무구분 RP \| 방언 POSTGRESQL \| \d{4}-\d{2}-\d{2} \d{2}:\d{2} \| viewer$/,
    );
    expect(body(r.text)).toBe(body(golden('default', 'RP_RSCH_PRJ_MAST')));
    const dc = await v.get(`${P}/tables/${id}/ddl?dropIfExists=true&codeColumnStyle=CHECK`);
    expect(body(dc.text)).toBe(body(golden('drop-check', 'RP_RSCH_PRJ_MAST')));
    const low = await v.get(
      `${P}/tables/${id}/ddl?identifierCase=LOWER&includeHeader=false&schemaName=rp`,
    );
    expect(low.text.startsWith('CREATE TABLE rp.rp_rsch_prj_mast (')).toBe(true);
    const j = (await v.get(`${P}/tables/${id}/ddl?format=json`)).body as DdlResponse;
    expect(j).toMatchObject({ dialect: 'POSTGRESQL', tableCnt: 1 });
    expect(j.tables[0]).toMatchObject({ tableId: id, tableNm: 'RP_RSCH_PRJ_MAST', status: 'FINAL' });
    expect((await v.get(`${P}/tables/${id}/ddl?dialect=ORACLE`)).status).toBe(422);
    expect((await v.get(`${P}/tables/${id}/ddl?schemaName=1x`)).status).toBe(400);
    expect((await v.get(`${P}/tables/${other.tableId}/ddl`)).status).toBe(404);
    expect(await logs()).toEqual([]); // 미리보기는 기록하지 않는다
  });
});

describe('다중 DDL POST P/ddl(T7.8)', () => {
  it('JSON 미리보기: bizAreaIds → 33 테이블(물리명 순), SINGLE sql·파일명·경고, 기록 없음', async () => {
    const v = await as('viewer');
    const r = await v.post(`${P}/ddl`, { bizAreaIds: [rpBizId] });
    expect(r.status).toBe(200);
    const d = r.body as DdlResponse;
    expect(d.tableCnt).toBe(33);
    expect(d.tables.map((x) => x.tableNm)).toEqual(Object.keys(tableId).sort());
    expect(d.sql.match(/^CREATE TABLE /gm)).toHaveLength(33);
    expect(d.sql.match(/^-- TermFlow DDL/gm)).toHaveLength(1);
    expect(d.files).toHaveLength(1);
    expect(d.files[0]!.name).toMatch(/^RMS_POSTGRESQL_\d{8}_\d{4}\.sql$/);
    expect(d.warnings.filter((w) => w.code === 'W_PK_NONE')).toHaveLength(3);
    expect(d.warnings.every((w) => w.tableNm)).toBe(true);
    // 테이블별 결과 = 단일 DDL(골든)
    const one = d.tables.find((x) => x.tableNm === 'RP_ELC_APV_MAST')!;
    expect(body(one.sql)).toBe(body(golden('default', 'RP_ELC_APV_MAST')));
    const per = (
      await v.post(`${P}/ddl`, { bizAreaIds: [rpBizId], options: { fileSplit: 'PER_TABLE' } })
    ).body as DdlResponse;
    expect(per.files).toHaveLength(34);
    expect(per.files[0]!.name).toBe('RP/01_RP_ELC_APV_MAST.sql');
    expect(await logs()).toEqual([]);
  });

  it('tableIds는 사용자 순서 유지, bizAreaIds와 합치면 중복 없이 뒤에 붙는다', async () => {
    const v = await as('viewer');
    const ids = [tableId['RP_WRK_HST_DTL']!, tableId['RP_ELC_APV_MAST']!];
    const d = (await v.post(`${P}/ddl`, { tableIds: ids })).body as DdlResponse;
    expect(d.tables.map((x) => x.tableNm)).toEqual(['RP_WRK_HST_DTL', 'RP_ELC_APV_MAST']);
    expect(d.sql).toContain('-- 1/2 RP_WRK_HST_DTL');
    const both = (await v.post(`${P}/ddl`, { tableIds: ids, bizAreaIds: [rpBizId] }))
      .body as DdlResponse;
    expect(both.tableCnt).toBe(33);
    expect(both.tables.slice(0, 2).map((x) => x.tableNm)).toEqual([
      'RP_WRK_HST_DTL',
      'RP_ELC_APV_MAST',
    ]);
  });

  it('SQL 다운로드: text/plain 첨부 + DOWNLOAD 기록', async () => {
    const v = await as('viewer');
    const r = await v.post(`${P}/ddl`, {
      tableIds: [tableId['RP_RSCH_PRJ_MAST']!],
      output: 'SQL',
    });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/plain/);
    expect(r.headers['content-disposition']).toMatch(
      /^attachment; filename="RMS_POSTGRESQL_\d{8}_\d{4}\.sql"/,
    );
    expect(body(r.text)).toBe(body(golden('default', 'RP_RSCH_PRJ_MAST')));
    expect((await logs()).at(-1)).toEqual({
      output_kind: 'DOWNLOAD',
      table_cnt: 1,
      exported_by: 'viewer',
    });
  });

  it('ZIP: `{BIZ_CD}/{NN}_{TABLE}.sql` 33 + `_warnings.txt`, 파일 = 골든(DROP+CHECK), ZIP 기록', async () => {
    const v = await as('viewer');
    const t0 = performance.now();
    const r = await v.downloadPost(`${P}/ddl`, {
      bizAreaIds: [rpBizId],
      output: 'ZIP',
      options: { dropIfExists: true, codeColumnStyle: 'CHECK' },
    });
    const ms = performance.now() - t0;
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/zip');
    expect(r.headers['content-disposition']).toMatch(/filename="RMS_POSTGRESQL_\d{8}_\d{4}\.zip"/);
    const files = await unzipText(r.body as Buffer);
    const names = Object.keys(files).sort();
    expect(names).toHaveLength(34);
    expect(names[0]).toBe('RP/01_RP_ELC_APV_MAST.sql');
    expect(names.at(-1)).toBe('_warnings.txt');
    expect(names.filter((n) => /^RP\/\d{2}_RP_[A-Z0-9_]+\.sql$/.test(n))).toHaveLength(33);
    for (const [name, content] of Object.entries(files)) {
      if (name === '_warnings.txt') continue;
      const tbl = name.replace(/^RP\/\d{2}_/, '').replace(/\.sql$/, '');
      expect(body(content), name).toBe(body(golden('drop-check', tbl)));
    }
    expect(files['_warnings.txt']).toContain('경고 7건: W_SUFFIX_UNREGISTERED 4, W_PK_NONE 3');
    console.log(`[test:db ddl] ZIP 33 테이블 API ${ms.toFixed(0)}ms`);
    expect((await logs()).at(-1)).toEqual({
      output_kind: 'ZIP',
      table_cnt: 33,
      exported_by: 'viewer',
    });
  });

  it('33 테이블 DDL API(JSON) 1초 이내', async () => {
    const v = await as('viewer');
    await v.post(`${P}/ddl`, { bizAreaIds: [rpBizId] });
    const t0 = performance.now();
    expect((await v.post(`${P}/ddl`, { bizAreaIds: [rpBizId] })).status).toBe(200);
    const ms = performance.now() - t0;
    console.log(`[test:db ddl] DDL 33 테이블 API(JSON) ${ms.toFixed(0)}ms`);
    expect(ms).toBeLessThan(perfLimit(1000, 5000));
  });

  it('오류: 다른 프로젝트·없는 ID 404, 빈 업무구분 422 E_DDL_NO_TABLES, 방언 422, 형식 400', async () => {
    const v = await as('viewer');
    const nf = await v.post(`${P}/ddl`, { tableIds: [other.tableId] });
    expect(nf.status).toBe(404);
    expect((await v.post(`${P}/ddl`, { bizAreaIds: [other.bizAreaId] })).status).toBe(404);
    const empty = await v.post(`${P}/ddl`, { bizAreaIds: [acBizId] });
    expect(empty.status).toBe(422);
    expect((empty.body as ProblemDetail).errors?.[0]?.code).toBe('E_DDL_NO_TABLES');
    const ora = await v.post(`${P}/ddl`, { bizAreaIds: [rpBizId], dialect: 'ORACLE' });
    expect(ora.status).toBe(422);
    expect((ora.body as ProblemDetail).errors?.[0]?.code).toBe('E_DIALECT_UNSUPPORTED');
    expect((await v.post(`${P}/ddl`, {})).status).toBe(400);
    const many = Array.from({ length: 201 }, (_, i) => i + 1);
    expect((await v.post(`${P}/ddl`, { tableIds: many })).status).toBe(400);
  });

  it('E가 있는 테이블이 섞이면 422(errors·warnings), quoteIdentifiers=true면 예약어 통과', async () => {
    const r = await t.pool.query<{ table_id: number }>(
      `insert into prj_table (project_id, biz_area_id, table_nm, table_logical_nm, status, created_by, updated_by)
       values ($1, $2, 'RP_ZZ_RESERVED', '예약어 테이블', 'DRAFT', 'editor', 'editor') returning table_id`,
      [rmsId, rpBizId],
    );
    const zid = r.rows[0]!.table_id;
    await t.pool.query(
      `insert into prj_column (project_id, table_id, col_seq, logical_nm, physical_nm, is_pk, data_type, data_length, is_nullable, col_comment, created_by, updated_by)
       values ($1, $2, 1, '순서', 'ORDER', true, 'VARCHAR', 10, false, '순서', 'editor', 'editor'),
              ($1, $2, 2, '메모', 'MEMO', false, 'VARCHAR', 100, true, $3, 'editor', 'editor')`,
      [rmsId, zid, "고객's\n메모"],
    );
    try {
      const v = await as('viewer');
      const bad = await v.post(`${P}/ddl`, { tableIds: [tableId['RP_RSCH_PRJ_MAST']!, zid] });
      expect(bad.status).toBe(422);
      const pd = bad.body as ProblemDetail;
      expect(pd.errors?.map((e) => [e.code, e.tableNm, e.columnNm])).toEqual([
        ['E_RESERVED', 'RP_ZZ_RESERVED', 'ORDER'],
      ]);
      expect(pd.detail).toContain('테이블 1개');
      const ok = await v.post(`${P}/ddl`, { tableIds: [zid], options: { quoteIdentifiers: true } });
      expect(ok.status).toBe(200);
      const sql = (ok.body as DdlResponse).sql;
      expect(sql).toContain('"ORDER"');
      expect(sql).toContain(`COMMENT ON COLUMN "RP_ZZ_RESERVED"."MEMO" IS '고객''s 메모';`);
      // 목록에도 오류 수가 보인다
      const list = (await v.get(`${P}/tables?q=RP_ZZ`)).body as TablePage;
      expect(list.items[0]).toMatchObject({ errorCnt: 1, status: 'DRAFT' });
      expect(list.statusCounts).toEqual({ DRAFT: 1, FINAL: 0 });
    } finally {
      await t.pool.query('delete from prj_table where table_id = $1', [zid]);
    }
  });

  it('draft(편집기 미리보기): 저장 전 본문으로 생성, 다른 프로젝트 업무구분은 422', async () => {
    const v = await as('viewer');
    const draft = {
      table: { bizAreaId: rpBizId, tableNm: 'RP_NEW_TBL', tableLogicalNm: '새 테이블' },
      columns: [
        {
          logicalNm: '아이디',
          physicalNm: 'NEW_ID',
          isPk: true,
          isNullable: false,
          dataType: 'VARCHAR',
          dataLength: 20,
          colComment: '아이디',
        },
        {
          logicalNm: '금액',
          physicalNm: 'AMT',
          dataType: 'NUMERIC',
          dataLength: 12,
          dataScale: 2,
          defaultVal: '0',
          colComment: '금액',
        },
      ],
    };
    const r = await v.post(`${P}/ddl`, { draft });
    expect(r.status).toBe(200);
    const d = r.body as DdlResponse;
    expect(d.tables[0]).toMatchObject({ tableId: null, tableNm: 'RP_NEW_TBL', version: null });
    expect(d.sql).toContain('CREATE TABLE RP_NEW_TBL (');
    expect(d.sql).toContain('    AMT                  NUMERIC(12,2)  DEFAULT 0,');
    const cross = await v.post(`${P}/ddl`, {
      draft: { ...draft, table: { ...draft.table, bizAreaId: other.bizAreaId } },
    });
    expect(cross.status).toBe(422);
    expect((cross.body as ProblemDetail).errors?.[0]?.code).toBe('E_BIZ_AREA_NOT_FOUND');
    const bad = await v.post(`${P}/ddl`, {
      draft: { ...draft, columns: [{ ...draft.columns[0], dataType: null }] },
    });
    expect(bad.status).toBe(422);
    expect((bad.body as ProblemDetail).errors?.map((e) => e.code)).toEqual(['E_TYPE_MISSING']);
  });
});

describe('정보 추출 POST P/ddl/extract(§6.11)', () => {
  it('JSON 미리보기: 헤더 1행 + 649행 + 테이블 사이 빈 줄 32, 탭 구분 13열', async () => {
    const v = await as('viewer');
    const r = await v.post(`${P}/ddl/extract`, { bizAreaIds: [rpBizId] });
    expect(r.status).toBe(200);
    const x = r.body as DdlExtractResponse;
    expect(x).toMatchObject({ dialect: 'POSTGRESQL', tableCnt: 33, rowCnt: 649 });
    const lines = x.text.trimEnd().split('\n');
    expect(lines[0]).toBe(
      '업무구분\t테이블물리명\t테이블논리명\t순번\t컬럼논리명\t컬럼물리명\tPK\t타입\tNULL허용\t기본값\t코멘트\t코드구분\t도메인',
    );
    expect(lines).toHaveLength(1 + 649 + 32);
    expect(lines.filter((l) => l === '')).toHaveLength(32);
    expect(lines.filter((l) => l !== '').every((l) => l.split('\t').length === 13)).toBe(true);
    const code = lines
      .find((l) => l.startsWith('RP\tRP_RSCH_PRJ_MAST\t') && l.includes('\tPRGRS_STAT_CD\t'))!
      .split('\t');
    expect(code[11]).toMatch(/^RP\/040 /);
    expect(x.fileName).toMatch(/^RMS_tables_\d{8}_\d{4}\.tsv$/);
    expect(await logs()).not.toContainEqual(expect.objectContaining({ output_kind: 'EXTRACT' }));
  });

  it('TSV 다운로드: BOM + 첨부 + EXTRACT 기록', async () => {
    const v = await as('viewer');
    const r = await v.post(`${P}/ddl/extract`, {
      tableIds: [tableId['RP_RSCH_PRJ_MAST']!],
      output: 'TSV',
    });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/tab-separated-values/);
    expect(r.headers['content-disposition']).toMatch(/filename="RMS_tables_\d{8}_\d{4}\.tsv"/);
    expect(r.text.charCodeAt(0)).toBe(0xfeff);
    expect((await logs()).at(-1)).toEqual({
      output_kind: 'EXTRACT',
      table_cnt: 1,
      exported_by: 'viewer',
    });
  });
});

describe('내보내기 기록 P/export-logs(§3.5.15)', () => {
  it('POST COPY 201 → GET 최근순(첫 테이블명·사용자명), 다운로드 종류는 거부', async () => {
    const v = await as('viewer');
    const ids = [tableId['RP_PLND_MAST']!, tableId['RP_RDC_MAST']!];
    const r = await v.post(`${P}/export-logs`, { kind: 'COPY', tableIds: ids, warningCnt: 2 });
    expect(r.status).toBe(201);
    expect((await v.post(`${P}/export-logs`, { kind: 'ZIP', tableIds: ids })).status).toBe(400);
    expect(
      (await v.post(`${P}/export-logs`, { kind: 'COPY', tableIds: [other.tableId] })).status,
    ).toBe(404);
    const list = (await v.get(`${P}/export-logs?size=10`)).body as Page<ExportLogItem>;
    expect(list.items[0]).toMatchObject({
      outputKind: 'COPY',
      tableIds: ids,
      tableCnt: 2,
      warningCnt: 2,
      firstTableNm: 'RP_PLND_MAST',
      exportedBy: 'viewer',
      exportedByNm: '조회자',
      dialect: 'POSTGRESQL',
    });
    expect(list.items.map((x) => x.outputKind)).toEqual(['COPY', 'EXTRACT', 'ZIP', 'DOWNLOAD']);
    expect(list.total).toBe(4);
  });

  it('보관 프로젝트에서도 DDL·추출·복사 기록은 허용(조회성 POST), 다른 쓰기는 409', async () => {
    await t.pool.query("update tf_project set status = 'ARCHIVED' where project_id = $1", [rmsId]);
    try {
      const v = await as('viewer');
      expect((await v.post(`${P}/ddl`, { bizAreaIds: [rpBizId] })).status).toBe(200);
      expect((await v.post(`${P}/ddl/extract`, { bizAreaIds: [rpBizId] })).status).toBe(200);
      expect(
        (await v.post(`${P}/export-logs`, { kind: 'COPY', tableIds: [tableId['RP_RDC_MAST']!] }))
          .status,
      ).toBe(201);
      const pa = await as('pa');
      const w = await pa.post(`${P}/standards/terms`, {
        termKor: '보관테스트',
        termPhysical: 'ARCV',
      });
      expect(w.status).toBe(409);
    } finally {
      await t.pool.query("update tf_project set status = 'ACTIVE' where project_id = $1", [rmsId]);
    }
  });
});
