import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  DdlResponse,
  TableConflict,
  TableDetail,
  TableHistoryItem,
  TableSaveResponse,
  TableStatusResponse,
  TableValidateResponse,
  ValidationIssue,
} from '@termflow/shared';
import { Client, createTestApp, setTestEnv } from './setup/app.js';
import { FIXTURE_PASSWORD, useTestDb } from './setup/databases.js';

/**
 * 단계 8 테이블 API(T8.1~T8.4·T8.15): 생성·조회·저장 diff·검증 422·IDOR·상태 전이·삭제·템플릿·보관,
 * G5(2인 동시 저장: 409 → 덮어쓰기 → 이력 2건·손실 0), CR-01-2(두 프로젝트 같은 RP·같은 테이블명 독립).
 * 데이터: std_small(PRJA·PRJB: 같은 업무구분 RP·같은 테이블 RP_RSCH_PRJ_MST, 서로 다른 표준) + 편집자 2(editor·editor1).
 * `pnpm test:db -- table`
 */
const t = useTestDb('t_table_api', { fixture: 'std_small' });
let app: INestApplication;
const PA = '/api/v1/projects/PRJA';
const PB = '/api/v1/projects/PRJB';
const ids = {
  rp: 0,
  ps: 0,
  bRp: 0,
  aTable: 0,
  bTable: 0,
  bDomain: 0,
  bCodeCls: 0,
  bDefaultCol: 0,
  aDomain: 0,
  aDefaultCol: 0,
};

beforeAll(async () => {
  await t.pool.query(`insert into tf_user (login_id, user_nm, password_hash, pw_change_required, created_by, updated_by)
     select 'editor1', '편집자1', password_hash, false, 'SYSTEM', 'SYSTEM' from tf_user where login_id = 'editor'`);
  await t.pool.query(`insert into tf_project_member (project_id, user_id, member_role, created_by, updated_by)
     select p.project_id, u.user_id, 'EDITOR', 'SYSTEM', 'SYSTEM' from tf_project p, tf_user u
      where p.project_key = 'PRJA' and u.login_id = 'editor1'`);
  const one = async (q: string) => (await t.pool.query(q)).rows[0].id as number;
  const pid = (k: string) => `(select project_id from tf_project where project_key = '${k}')`;
  ids.rp = await one(`select biz_area_id id from prj_biz_area where project_id = ${pid('PRJA')} and biz_cd = 'RP'`);
  ids.ps = await one(`select biz_area_id id from prj_biz_area where project_id = ${pid('PRJA')} and biz_cd = 'PS'`);
  ids.bRp = await one(`select biz_area_id id from prj_biz_area where project_id = ${pid('PRJB')} and biz_cd = 'RP'`);
  ids.aTable = await one(`select table_id id from prj_table where project_id = ${pid('PRJA')}`);
  ids.bTable = await one(`select table_id id from prj_table where project_id = ${pid('PRJB')}`);
  ids.bDomain = await one(`select min(domain_id) id from std_domain where project_id = ${pid('PRJB')}`);
  ids.aDomain = await one(`select min(domain_id) id from std_domain where project_id = ${pid('PRJA')}`);
  ids.bCodeCls = await one(`select min(code_cls_id) id from std_code_cls where project_id = ${pid('PRJB')}`);
  ids.bDefaultCol = await one(`select min(default_col_id) id from std_default_col where project_id = ${pid('PRJB')}`);
  ids.aDefaultCol = await one(`select min(default_col_id) id from std_default_col where project_id = ${pid('PRJA')}`);
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
const col = (nm: string, over: Record<string, unknown> = {}) => ({
  columnId: null,
  logicalNm: `${nm} 논리`,
  physicalNm: nm,
  isPk: false,
  dataType: 'VARCHAR',
  dataLength: 20,
  isNullable: true,
  colComment: `${nm} 코멘트`,
  matchType: 'MANUAL',
  ...over,
});
const body = (tableNm: string, columns: object[], over: Record<string, unknown> = {}) => ({
  table: { bizAreaId: ids.rp, tableNm, tableLogicalNm: `${tableNm} 논리`, description: null, ...over },
  columns,
});
/** GET 결과 → 저장 본문(편집기가 보내는 형태: columnId 유지). */
const toBody = (d: TableDetail) => ({
  version: d.table.version,
  table: {
    bizAreaId: d.table.bizAreaId,
    tableNm: d.table.tableNm,
    tableLogicalNm: d.table.tableLogicalNm,
    description: d.table.description,
  },
  columns: d.columns.map(({ domainNm: _d, codeCls: _c, colSeq: _s, ...c }) => c),
});
const codes = (r: { body: unknown }) =>
  ((r.body as { errors?: ValidationIssue[] }).errors ?? []).map((e) => e.code);
const history = async (tableId: number) =>
  (
    await t.pool.query<{ version: number; action: string; change_summary: string; saved_by: string; snapshot: { columns: { physicalNm: string; columnId: number }[] } }>(
      'select version, action, change_summary, saved_by, snapshot from prj_table_history where table_id = $1 order by version',
      [tableId],
    )
  ).rows;

describe('생성·조회(T8.1)', () => {
  it('POST P/tables → 201(version 1·Location·새 ID), 이력 CREATE, GET 상세(업무구분·컬럼·재검증 W)', async () => {
    const e = await as('editor');
    const r = await e.post(`${PA}/tables`, body('RP_NEW_MST', [col('NEW_ID', { isPk: true }), col('NEW_NM')]));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const s = r.body as TableSaveResponse;
    expect(s).toMatchObject({ version: 1, status: 'DRAFT', changeSummary: '테이블 생성 · 컬럼 2' });
    expect(s.columns.map((c) => c.colSeq)).toEqual([1, 2]);
    expect(r.headers['location']).toBe(`/api/v1/projects/PRJA/tables/${s.tableId}`);
    const h = await history(s.tableId);
    expect(h).toMatchObject([{ version: 1, action: 'CREATE', saved_by: 'editor' }]);

    const d = (await e.get(`${PA}/tables/${s.tableId}`)).body as TableDetail;
    expect(d.table).toMatchObject({ tableNm: 'RP_NEW_MST', bizCd: 'RP', tablePrefix: 'RP_', status: 'DRAFT', version: 1, updatedByNm: '편집자' });
    expect(d.columns.map((c) => [c.physicalNm, c.isPk, c.isNullable])).toEqual([
      ['NEW_ID', true, false],
      ['NEW_NM', false, true],
    ]);
    expect(d.errors).toEqual([]);
    expect(d.warnings.map((w) => w.code)).toContain('W_SUFFIX_UNREGISTERED');
    // 조회자 조회 가능·쓰기 403
    const v = await as('viewer');
    expect((await v.get(`${PA}/tables/${s.tableId}`)).status).toBe(200);
    expect((await v.post(`${PA}/tables`, body('RP_V', [col('A')]))).status).toBe(403);
    expect((await v.put(`${PA}/tables/${s.tableId}`, { ...toBody(d) })).status).toBe(403);
    // 다른 프로젝트의 테이블 ID → 404(존재 노출 방지)
    expect((await e.get(`${PA}/tables/${ids.bTable}`)).status).toBe(404);
  });

  it('업무구분: 미지정 422 E_BIZ_AREA_REQUIRED · 다른 프로젝트 422 E_BIZ_AREA_NOT_FOUND · 사용 중지 422 E_BIZ_AREA_INACTIVE', async () => {
    const e = await as('editor');
    const r1 = await e.post(`${PA}/tables`, body('RP_NOBIZ', [col('A')], { bizAreaId: null }));
    expect(r1.status).toBe(422);
    expect(codes(r1)).toEqual(['E_BIZ_AREA_REQUIRED']);
    const r2 = await e.post(`${PA}/tables`, body('RP_OTHERBIZ', [col('A')], { bizAreaId: ids.bRp }));
    expect(r2.status).toBe(422);
    expect(codes(r2)).toEqual(['E_BIZ_AREA_NOT_FOUND']);
    await t.pool.query('update prj_biz_area set use_yn = false where biz_area_id = $1', [ids.ps]);
    try {
      const r3 = await e.post(`${PA}/tables`, body('PS_OFF', [col('A')], { bizAreaId: ids.ps }));
      expect(r3.status).toBe(422);
      expect(codes(r3)).toEqual(['E_BIZ_AREA_INACTIVE']);
    } finally {
      await t.pool.query('update prj_biz_area set use_yn = true where biz_area_id = $1', [ids.ps]);
    }
  });

  it('템플릿 테이블 쓰기 409 E_TEMPLATE_NO_TABLES(CR-04 C9), 보관 프로젝트 쓰기 409 E_PROJECT_READONLY', async () => {
    const sa = await as('sysadmin');
    const stdsRp = (
      await t.pool.query(
        "select biz_area_id id from prj_biz_area b join tf_project p using (project_id) where p.project_key = 'STDS' and b.biz_cd = 'RP'",
      )
    ).rows[0].id as number;
    const r = await sa.post('/api/v1/projects/STDS/tables', body('RP_TPL', [col('A')], { bizAreaId: stdsRp }));
    expect(r.status).toBe(409);
    expect((r.body as { code: string }).code).toBe('E_TEMPLATE_NO_TABLES');
    await t.pool.query("update tf_project set status = 'ARCHIVED' where project_key = 'PRJB'");
    try {
      const p = await as('pa');
      const d = (await p.get(`${PB}/tables/${ids.bTable}`)).body as TableDetail;
      const w = await p.put(`${PB}/tables/${ids.bTable}`, toBody(d));
      expect(w.status).toBe(409);
      expect((w.body as { code: string }).code).toBe('E_PROJECT_READONLY');
    } finally {
      await t.pool.query("update tf_project set status = 'ACTIVE' where project_key = 'PRJB'");
    }
  });
});

describe('저장 전 검증(T8.3): 코드표 E 전 항목 422', () => {
  // 본문은 beforeAll 이후(ID 채움) 만들어야 하므로 함수로 둔다
  const cases: [string, () => object, string][] = [
    ['E_LOGICAL_EMPTY', () => body('RP_E1', [col('A', { logicalNm: '' })]), 'E_LOGICAL_EMPTY'],
    ['E_PHYS_EMPTY', () => body('RP_E2', [col('')]), 'E_PHYS_EMPTY'],
    ['E_PHYS_FORMAT(컬럼)', () => body('RP_E3', [col('rsch-id')]), 'E_PHYS_FORMAT'],
    ['E_PHYS_FORMAT(테이블)', () => body('1RP_E4', [col('A')]), 'E_PHYS_FORMAT'],
    ['E_PHYS_DUP', () => body('RP_E5', [col('A'), col('A')]), 'E_PHYS_DUP'],
    ['E_PHYS_LEN', () => body('RP_E6', [col(`A${'B'.repeat(63)}`)]), 'E_PHYS_LEN'],
    ['E_RESERVED', () => body('RP_E7', [col('ORDER')]), 'E_RESERVED'],
    ['E_TYPE_MISSING', () => body('RP_E8', [col('A', { dataType: null, dataLength: null })]), 'E_TYPE_MISSING'],
    ['E_TYPE_LEN_MISSING', () => body('RP_E9', [col('A', { dataLength: null })]), 'E_TYPE_LEN_MISSING'],
    ['E_TYPE_LEN_RANGE', () => body('RP_E10', [col('A', { dataType: 'NUMERIC', dataLength: 4, dataScale: 6 })]), 'E_TYPE_LEN_RANGE'],
    ['E_TABLE_NM_DUP', () => body('RP_RSCH_PRJ_MST', [col('A')]), 'E_TABLE_NM_DUP'],
    ['E_BIZ_AREA_REQUIRED', () => body('RP_E12', [col('A')], { bizAreaId: null }), 'E_BIZ_AREA_REQUIRED'],
  ];
  it.each(cases)('%s', async (_n, mk, code) => {
    const b = mk();
    const e = await as('editor');
    const r = await e.post(`${PA}/tables`, b);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect((r.body as { type: string }).type).toMatch(/\/validation$/);
    expect(codes(r)).toContain(code);
    const issue = (r.body as { errors: ValidationIssue[] }).errors.find((x) => x.code === code)!;
    expect(issue.message.length).toBeGreaterThan(0);
    // 같은 본문을 validate로 보내면 200 + 같은 오류(기록 없음)
    const v = await e.post(`${PA}/tables/validate`, b);
    expect(v.status).toBe(200);
    expect((v.body as TableValidateResponse).errors.map((x) => x.code)).toContain(code);
  });

  it('E_PK_NULLABLE: PK + NULL 허용은 저장 시 NOT NULL로 자동 보정(보정 후 남지 않음, CR-07 C3)', async () => {
    const e = await as('editor');
    const r = await e.post(`${PA}/tables`, body('RP_PKNULL', [col('PK_ID', { isPk: true, isNullable: true })]));
    expect(r.status).toBe(201);
    const d = (await e.get(`${PA}/tables/${(r.body as TableSaveResponse).tableId}`)).body as TableDetail;
    expect(d.columns[0]).toMatchObject({ isPk: true, isNullable: false });
  });

  it('소문자 물리명은 대문자로 정규화, validate는 tableId(자기 자신)를 이름 중복에서 뺀다', async () => {
    const e = await as('editor');
    const r = await e.post(`${PA}/tables`, body('rp_lower_mst', [col('lower_id')]));
    expect(r.status).toBe(201);
    const d = (await e.get(`${PA}/tables/${(r.body as TableSaveResponse).tableId}`)).body as TableDetail;
    expect(d.table.tableNm).toBe('RP_LOWER_MST');
    expect(d.columns[0]!.physicalNm).toBe('LOWER_ID');
    const self = await e.post(`${PA}/tables/validate`, { ...toBody(d), tableId: d.table.tableId });
    expect((self.body as TableValidateResponse).errors).toEqual([]);
    const other = await e.post(`${PA}/tables/validate`, toBody(d));
    expect((other.body as TableValidateResponse).errors.map((x) => x.code)).toEqual(['E_TABLE_NM_DUP']);
  });

  it('IDOR(CR-01-3): 다른 프로젝트의 domainId·codeClsId·defaultColId → 422(행·필드), 생성·저장 모두', async () => {
    const e = await as('editor');
    const r = await e.post(
      `${PA}/tables`,
      body('RP_IDOR', [
        col('A', { domainId: ids.bDomain }),
        col('B', { codeClsId: ids.bCodeCls, matchType: 'CODE' }),
        col('C', { defaultColId: ids.bDefaultCol }),
      ]),
    );
    expect(r.status).toBe(422);
    const errs = (r.body as { errors: ValidationIssue[] }).errors;
    expect(errs.map((x) => [x.code, x.rowIndex, x.field])).toEqual([
      ['E_DOMAIN_NOT_FOUND', 0, 'domainId'],
      ['E_CODE_CLS_NOT_FOUND', 1, 'codeClsId'],
      ['E_DEFAULT_COL_NOT_FOUND', 2, 'defaultColId'],
    ]);
    const d = (await e.get(`${PA}/tables/${ids.aTable}`)).body as TableDetail;
    const b = toBody(d);
    b.columns[0] = { ...b.columns[0]!, domainId: ids.bDomain };
    const p = await e.put(`${PA}/tables/${ids.aTable}`, b);
    expect(p.status).toBe(422);
    expect(codes(p)).toEqual(['E_DOMAIN_NOT_FOUND']);
    // 자기 프로젝트 참조는 통과
    b.columns[0] = { ...b.columns[0]!, domainId: ids.aDomain };
    expect((await e.post(`${PA}/tables/validate`, { ...b, tableId: ids.aTable })).body).toMatchObject({ errors: [] });
  });
});

describe('저장 PUT(T8.2): 낙관적 잠금·diff·스냅샷', () => {
  it('수정 1·추가 1·삭제 1·순서 변경 → "컬럼 +1 ~1 -1, 순서 변경", 새 ID 반환 → 두 번째 저장은 update 경로', async () => {
    const e = await as('editor');
    const c = await e.post(`${PA}/tables`, body('RP_DIFF_MST', [col('A'), col('B'), col('C')]));
    const id = (c.body as TableSaveResponse).tableId;
    const d = (await e.get(`${PA}/tables/${id}`)).body as TableDetail;
    const [a, b] = toBody(d).columns;
    const r = await e.put(`${PA}/tables/${id}`, {
      ...toBody(d),
      columns: [{ ...b!, dataLength: 50 }, col('D'), a],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const s = r.body as TableSaveResponse;
    expect(s.version).toBe(2);
    expect(s.changeSummary).toBe('컬럼 +1 ~1 -1, 순서 변경');
    expect(s.columns.map((x) => x.colSeq)).toEqual([1, 2, 3]);
    expect(s.columns[0]!.columnId).toBe(b!.columnId);
    expect(s.columns[2]!.columnId).toBe(a!.columnId);
    const newD = s.columns[1]!.columnId;
    expect([a!.columnId, b!.columnId]).not.toContain(newD);

    const d2 = (await e.get(`${PA}/tables/${id}`)).body as TableDetail;
    expect(d2.columns.map((x) => x.physicalNm)).toEqual(['B', 'D', 'A']);
    const r2 = await e.put(`${PA}/tables/${id}`, toBody(d2));
    expect((r2.body as TableSaveResponse).changeSummary).toBe('컬럼 +0 ~0 -0');
    expect((r2.body as TableSaveResponse).columns.map((x) => x.columnId)).toEqual(d2.columns.map((x) => x.columnId));
    const h = await history(id);
    expect(h.map((x) => [x.version, x.action])).toEqual([
      [1, 'CREATE'],
      [2, 'UPDATE'],
      [3, 'UPDATE'],
    ]);
    expect(h[1]!.snapshot.columns.map((x) => x.physicalNm)).toEqual(['B', 'D', 'A']);
  });

  it('순서만 변경하면 컬럼 감사(updated_by)를 갱신하지 않는다, 필드 변경은 갱신', async () => {
    const e = await as('editor');
    const c = await e.post(`${PA}/tables`, body('RP_SEQ_MST', [col('A'), col('B')]));
    const id = (c.body as TableSaveResponse).tableId;
    const d = (await e.get(`${PA}/tables/${id}`)).body as TableDetail;
    const p = await as('pa');
    const [a, b] = toBody(d).columns;
    await p.put(`${PA}/tables/${id}`, { ...toBody(d), columns: [b, a] });
    const rows = async () =>
      (await t.pool.query<{ physical_nm: string; col_seq: number; updated_by: string }>(
        'select physical_nm, col_seq, updated_by from prj_column where table_id = $1 order by col_seq',
        [id],
      )).rows;
    expect(await rows()).toEqual([
      { physical_nm: 'B', col_seq: 1, updated_by: 'editor' },
      { physical_nm: 'A', col_seq: 2, updated_by: 'editor' },
    ]);
    const d2 = (await p.get(`${PA}/tables/${id}`)).body as TableDetail;
    const cols = toBody(d2).columns;
    await p.put(`${PA}/tables/${id}`, { ...toBody(d2), columns: [cols[0], { ...cols[1]!, colComment: '바꿈' }] });
    expect((await rows())[1]!.updated_by).toBe('pa');
  });

  it('G5: A·B 같은 version → A 저장 → B 409(current·currentVersion) → B 덮어쓰기 → 이력 2건·손실 0', async () => {
    const A = await as('editor');
    const B = await as('editor1');
    const c = await A.post(`${PA}/tables`, body('RP_G5_MST', [col('BASE_ID', { isPk: true }), col('BASE_NM')]));
    const id = (c.body as TableSaveResponse).tableId;
    const dA = (await A.get(`${PA}/tables/${id}`)).body as TableDetail;
    const dB = (await B.get(`${PA}/tables/${id}`)).body as TableDetail;
    expect(dA.table.version).toBe(dB.table.version);
    const v0 = dA.table.version;

    // A: 컬럼 A_ONLY 추가 + BASE_NM 길이 변경
    const aBody = toBody(dA);
    aBody.columns[1] = { ...aBody.columns[1]!, dataLength: 100 };
    const ra = await A.put(`${PA}/tables/${id}`, { ...aBody, columns: [...aBody.columns, col('A_ONLY')] });
    expect(ra.status).toBe(200);
    expect((ra.body as TableSaveResponse).version).toBe(v0 + 1);

    // B: 같은 version으로 B_ONLY 추가 → 409
    const bBody = { ...toBody(dB), columns: [...toBody(dB).columns, col('B_ONLY')] };
    const rb = await B.put(`${PA}/tables/${id}`, bBody);
    expect(rb.status).toBe(409);
    const p = rb.body as TableConflict & { type: string; code: string; detail: string };
    expect(p.type).toMatch(/\/version-conflict$/);
    expect(p.code).toBe('E_VERSION_CONFLICT');
    expect(p).toMatchObject({ yourVersion: v0, currentVersion: v0 + 1, savedBy: '편집자' });
    expect(p.detail).toMatch(/^편집자이\(가\) \d\d:\d\d:\d\d에 저장했습니다\.$/);
    expect(p.current.table.version).toBe(v0 + 1);
    expect(p.current.columns.map((x) => x.physicalNm)).toEqual(['BASE_ID', 'BASE_NM', 'A_ONLY']);
    expect(p.current.columns[1]!.dataLength).toBe(100);
    // 409는 아무것도 바꾸지 않았다
    expect((await history(id)).map((x) => x.version)).toEqual([1, 2]);

    // B: [내 편집본으로 덮어쓰기] = currentVersion으로 같은 PUT 재전송(별도 force 플래그 없음)
    const ro = await B.put(`${PA}/tables/${id}`, { ...bBody, version: p.currentVersion });
    expect(ro.status, JSON.stringify(ro.body)).toBe(200);
    expect((ro.body as TableSaveResponse).version).toBe(v0 + 2);

    const h = await history(id);
    const updates = h.filter((x) => x.action === 'UPDATE');
    expect(updates.map((x) => [x.version, x.saved_by])).toEqual([
      [v0 + 1, 'editor'],
      [v0 + 2, 'editor1'],
    ]);
    // 손실 0: A의 편집본은 v+1 스냅샷에, B의 편집본은 현재본(v+2)에 그대로 있다
    expect(updates[0]!.snapshot.columns.map((x) => x.physicalNm)).toEqual(['BASE_ID', 'BASE_NM', 'A_ONLY']);
    const now = (await B.get(`${PA}/tables/${id}`)).body as TableDetail;
    expect(now.columns.map((x) => x.physicalNm)).toEqual(['BASE_ID', 'BASE_NM', 'B_ONLY']);
    expect(updates[1]!.snapshot.columns.map((x) => x.physicalNm)).toEqual(['BASE_ID', 'BASE_NM', 'B_ONLY']);
    // A가 v+1을 복원하면 A의 편집본이 새 버전으로 되살아난다(선형 이력)
    const rs = await A.post(`${PA}/tables/${id}/history/${v0 + 1}/restore`, { version: v0 + 2 });
    expect(rs.status).toBe(200);
    const back = (await A.get(`${PA}/tables/${id}`)).body as TableDetail;
    expect(back.columns.map((x) => x.physicalNm)).toEqual(['BASE_ID', 'BASE_NM', 'A_ONLY']);
  });
});

describe('상태 전이·삭제(T8.4)', () => {
  it('DRAFT→FINAL(편집자) → 편집·복원 409 E_TABLE_FINAL → 편집자 해제 403 → PA 해제(사유) → 같은 상태 409', async () => {
    const e = await as('editor');
    const c = await e.post(`${PA}/tables`, body('RP_ST_MST', [col('ST_ID')])); // PK 없음(W) — 확정 가능
    const id = (c.body as TableSaveResponse).tableId;
    const stale = await e.put(`${PA}/tables/${id}/status`, { status: 'FINAL', version: 9 });
    expect(stale.status).toBe(409);
    expect((stale.body as { code: string }).code).toBe('E_VERSION_CONFLICT');
    const f = await e.put(`${PA}/tables/${id}/status`, { status: 'FINAL', version: 1 });
    expect(f.status, JSON.stringify(f.body)).toBe(200);
    expect(f.body as TableStatusResponse).toMatchObject({ status: 'FINAL', version: 2, finalizedBy: 'editor' });
    const d = (await e.get(`${PA}/tables/${id}`)).body as TableDetail;
    expect(d.table.finalizedAt).not.toBeNull();
    const put = await e.put(`${PA}/tables/${id}`, toBody(d));
    expect(put.status).toBe(409);
    expect(put.body).toMatchObject({ code: 'E_TABLE_FINAL' });
    expect((put.body as { type: string }).type).toMatch(/\/table-finalized$/);
    const rs = await e.post(`${PA}/tables/${id}/history/1/restore`, { version: 2 });
    expect(rs.status).toBe(409);
    expect(rs.body).toMatchObject({ code: 'E_TABLE_FINAL' });
    expect((await e.put(`${PA}/tables/${id}/status`, { status: 'DRAFT', version: 2 })).status).toBe(403);
    const p = await as('pa');
    expect((await p.put(`${PA}/tables/${id}/status`, { status: 'FINAL', version: 2 })).body).toMatchObject({
      code: 'E_TABLE_STATUS_INVALID',
    });
    const u = await p.put(`${PA}/tables/${id}/status`, { status: 'DRAFT', version: 2, note: '컬럼 추가 요청' });
    expect(u.status).toBe(200);
    expect(u.body).toMatchObject({ status: 'DRAFT', version: 3, finalizedAt: null, finalizedBy: null });
    const h = await history(id);
    expect(h.map((x) => [x.version, x.action, x.change_summary])).toEqual([
      [1, 'CREATE', '테이블 생성 · 컬럼 1'],
      [2, 'FINALIZE', '확정(FINAL)'],
      [3, 'UNFINALIZE', '확정 해제(DRAFT): 컬럼 추가 요청'],
    ]);
    // 해제 후 다시 편집 가능
    const d3 = (await e.get(`${PA}/tables/${id}`)).body as TableDetail;
    expect((await e.put(`${PA}/tables/${id}`, toBody(d3))).status).toBe(200);
  });

  it('E가 남은 테이블은 FINAL 422(W만 있으면 허용)', async () => {
    const e = await as('editor');
    const c = await e.post(`${PA}/tables`, body('RP_ST_E', [col('A')]));
    const id = (c.body as TableSaveResponse).tableId;
    await t.pool.query('update prj_column set data_type = null, data_length = null where table_id = $1', [id]);
    const r = await e.put(`${PA}/tables/${id}/status`, { status: 'FINAL', version: 1 });
    expect(r.status).toBe(422);
    expect(codes(r)).toEqual(['E_TYPE_MISSING']);
  });

  it('삭제: DRAFT 편집자 204(컬럼·이력 CASCADE) · FINAL 편집자 403 / PA 204 · 없는 ID 404', async () => {
    const e = await as('editor');
    const c1 = await e.post(`${PA}/tables`, body('RP_DEL1', [col('A')]));
    const id1 = (c1.body as TableSaveResponse).tableId;
    expect((await e.delete(`${PA}/tables/${id1}`)).status).toBe(204);
    expect((await t.pool.query('select 1 from prj_column where table_id = $1', [id1])).rowCount).toBe(0);
    expect((await t.pool.query('select 1 from prj_table_history where table_id = $1', [id1])).rowCount).toBe(0);
    expect((await e.get(`${PA}/tables/${id1}`)).status).toBe(404);
    const c2 = await e.post(`${PA}/tables`, body('RP_DEL2', [col('A')]));
    const id2 = (c2.body as TableSaveResponse).tableId;
    await e.put(`${PA}/tables/${id2}/status`, { status: 'FINAL', version: 1 });
    expect((await e.delete(`${PA}/tables/${id2}`)).status).toBe(403);
    expect((await (await as('pa')).delete(`${PA}/tables/${id2}`)).status).toBe(204);
    expect((await e.delete(`${PA}/tables/999999`)).status).toBe(404);
    expect((await e.delete(`${PA}/tables/${ids.bTable}`)).status).toBe(404);
  });
});

describe('CR-01-2: 두 프로젝트(같은 RP·같은 테이블명) 독립', () => {
  it('PRJA의 RP_RSCH_PRJ_MST 저장이 PRJB에 영향 없음, 같은 새 이름은 양쪽 모두 생성 가능, DDL도 각자', async () => {
    const p = await as('pa');
    const before = (await p.get(`${PB}/tables/${ids.bTable}`)).body as TableDetail;
    const a = (await p.get(`${PA}/tables/${ids.aTable}`)).body as TableDetail;
    expect(a.table.tableNm).toBe(before.table.tableNm);
    const ab = toBody(a);
    const r = await p.put(`${PA}/tables/${ids.aTable}`, { ...ab, columns: [...ab.columns, col('ONLY_IN_A')] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = (await p.get(`${PB}/tables/${ids.bTable}`)).body as TableDetail;
    expect(after).toEqual(before);
    const ddl = async (base: string, id: number) =>
      ((await p.post(`${base}/ddl`, { tableIds: [id] })).body as DdlResponse).tables[0]!.sql;
    expect(await ddl(PA, ids.aTable)).toContain('ONLY_IN_A');
    expect(await ddl(PB, ids.bTable)).not.toContain('ONLY_IN_A');
    const ca = await p.post(`${PA}/tables`, body('RP_SAME_NEW', [col('A')]));
    const cb = await p.post(`${PB}/tables`, body('RP_SAME_NEW', [col('B')], { bizAreaId: ids.bRp }));
    expect([ca.status, cb.status]).toEqual([201, 201]);
    expect((await p.post(`${PA}/tables`, body('RP_SAME_NEW', [col('C')]))).status).toBe(422);
  });
});

describe('이력 조회 권한', () => {
  it('조회자: 목록·본문 200, 복원 403', async () => {
    const v = await as('viewer');
    const list = (await v.get(`${PA}/tables/${ids.aTable}/history`)).body as TableHistoryItem[];
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]).toMatchObject({ action: 'UPDATE', savedBy: 'pa', savedByNm: '프로젝트관리자' });
    expect((await v.get(`${PA}/tables/${ids.aTable}/history/${list[0]!.version}`)).status).toBe(200);
    expect((await v.post(`${PA}/tables/${ids.aTable}/history/${list[0]!.version}/restore`, { version: list[0]!.version })).status).toBe(403);
  });
});
