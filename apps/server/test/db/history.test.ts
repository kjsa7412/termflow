import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  TableDetail,
  TableHistoryDetail,
  TableHistoryItem,
  TableSaveResponse,
} from '@termflow/shared';
import { Client, createTestApp, setTestEnv } from './setup/app.js';
import { FIXTURE_PASSWORD, useTestDb } from './setup/databases.js';

/**
 * 단계 8 이력(T8.5, 설계서 §8.3): 목록·본문(schemaVersion)·복원(선형 이력, 삭제된 columnId는 신규 처리).
 * 데이터: std_small(PRJA). `pnpm test:db -- history`
 */
const t = useTestDb('t_table_history', { fixture: 'std_small' });
let app: INestApplication;
const PA = '/api/v1/projects/PRJA';
let rp = 0;

beforeAll(async () => {
  rp = (
    await t.pool.query(
      "select biz_area_id id from prj_biz_area b join tf_project p using (project_id) where p.project_key = 'PRJA' and b.biz_cd = 'RP'",
    )
  ).rows[0].id as number;
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
  dataType: 'VARCHAR',
  dataLength: 20,
  colComment: nm,
  ...over,
});
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

describe('이력·복원(T8.5)', () => {
  it('v1 생성 → v2(+C) → v3(-B) → v4(A 수정) → v2 복원 = v5(RESTORE), B는 새 ID, C·A는 ID 유지', async () => {
    const e = await as('editor');
    const c = await e.post(`${PA}/tables`, {
      table: {
        bizAreaId: rp,
        tableNm: 'RP_HIST_MST',
        tableLogicalNm: '이력시험',
        description: 'v1 설명',
      },
      columns: [col('A', { isPk: true }), col('B')],
    });
    expect(c.status).toBe(201);
    const id = (c.body as TableSaveResponse).tableId;
    const get = async () => (await e.get(`${PA}/tables/${id}`)).body as TableDetail;

    let d = await get();
    const v1Ids = Object.fromEntries(d.columns.map((x) => [x.physicalNm, x.columnId]));
    let b = toBody(d);
    await e.put(`${PA}/tables/${id}`, { ...b, columns: [...b.columns, col('C')] }); // v2
    d = await get();
    const idC = d.columns.find((x) => x.physicalNm === 'C')!.columnId;
    b = toBody(d);
    await e.put(`${PA}/tables/${id}`, {
      ...b,
      columns: b.columns.filter((x) => x.physicalNm !== 'B'),
    }); // v3
    d = await get();
    b = toBody(d);
    await e.put(`${PA}/tables/${id}`, {
      ...b,
      table: { ...b.table, description: 'v4 설명' },
      columns: b.columns.map((x) => (x.physicalNm === 'A' ? { ...x, colComment: 'v4 코멘트' } : x)),
    }); // v4

    const list = (await e.get(`${PA}/tables/${id}/history`)).body as TableHistoryItem[];
    expect(list.map((x) => [x.version, x.action, x.changeSummary])).toEqual([
      [4, 'UPDATE', '컬럼 +0 ~1 -0, 테이블 정보 변경'],
      [3, 'UPDATE', '컬럼 +0 ~0 -1, 순서 변경'],
      [2, 'UPDATE', '컬럼 +1 ~0 -0'],
      [1, 'CREATE', '테이블 생성 · 컬럼 2'],
    ]);
    expect(list[0]).toMatchObject({ savedBy: 'editor', savedByNm: '편집자' });
    expect(list[0]!.savedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/);

    const v2 = (await e.get(`${PA}/tables/${id}/history/2`)).body as TableHistoryDetail;
    expect(v2.snapshot.schemaVersion).toBe(1);
    expect(v2.snapshot.table).toMatchObject({
      tableId: id,
      projectKey: 'PRJA',
      bizCd: 'RP',
      version: 2,
      description: 'v1 설명',
    });
    expect(v2.snapshot.columns.map((x) => [x.physicalNm, x.columnId, x.colSeq])).toEqual([
      ['A', v1Ids['A'], 1],
      ['B', v1Ids['B'], 2],
      ['C', idC, 3],
    ]);
    expect((await e.get(`${PA}/tables/${id}/history/99`)).status).toBe(404);

    // 복원: 현재 version이 아니면 409(낙관적 잠금)
    const stale = await e.post(`${PA}/tables/${id}/history/2/restore`, { version: 3 });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'E_VERSION_CONFLICT', currentVersion: 4 });
    const r = await e.post(`${PA}/tables/${id}/history/2/restore`, { version: 4 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const s = r.body as TableSaveResponse;
    expect(s.version).toBe(5);
    expect(s.changeSummary).toBe('v2 복원 · 컬럼 +1 ~1 -0, 순서 변경, 테이블 정보 변경');

    d = await get();
    expect(d.table.version).toBe(5);
    expect(d.table.description).toBe('v1 설명');
    expect(d.columns.map((x) => x.physicalNm)).toEqual(['A', 'B', 'C']);
    const now = Object.fromEntries(d.columns.map((x) => [x.physicalNm, x]));
    expect(now['A']!.columnId).toBe(v1Ids['A']);
    expect(now['A']!.colComment).toBe('A');
    expect(now['C']!.columnId).toBe(idC);
    expect(now['B']!.columnId).not.toBe(v1Ids['B']); // v3에서 삭제된 ID → 신규 처리
    const v5 = (await e.get(`${PA}/tables/${id}/history/5`)).body as TableHistoryDetail;
    expect(v5).toMatchObject({ action: 'RESTORE' });
    expect(v5.snapshot.restoredFrom).toBe(2);
    // 과거 버전 번호로 되돌리지 않는다(선형): 1~5 모두 남음
    const all = (await e.get(`${PA}/tables/${id}/history`)).body as TableHistoryItem[];
    expect(all.map((x) => x.version)).toEqual([5, 4, 3, 2, 1]);
  });

  it('복원 시 그 사이 삭제된 도메인 참조는 연결 없음(NULL)으로, 다른 프로젝트 테이블 이력은 404', async () => {
    const e = await as('editor');
    const pa = await as('pa');
    const dom = (
      (await pa.post(`${PA}/standards/domains`, { nm1: '용어1', nm2: '이력도메인' })).body as {
        domain: { domainId: number };
      }
    ).domain;
    expect(dom.domainId).toBeGreaterThan(0);
    const c = await e.post(`${PA}/tables`, {
      table: {
        bizAreaId: rp,
        tableNm: 'RP_HIST_DOM',
        tableLogicalNm: '도메인 복원',
        description: null,
      },
      columns: [col('DOM_ID', { domainId: dom.domainId, matchType: 'EXACT' })],
    });
    const id = (c.body as TableSaveResponse).tableId;
    const d = (await e.get(`${PA}/tables/${id}`)).body as TableDetail;
    await e.put(`${PA}/tables/${id}`, { ...toBody(d), columns: [col('OTHER')] }); // v2
    expect([200, 204]).toContain(
      (await pa.delete(`${PA}/standards/domains/${dom.domainId}`)).status,
    );
    const r = await e.post(`${PA}/tables/${id}/history/1/restore`, { version: 2 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = (await e.get(`${PA}/tables/${id}`)).body as TableDetail;
    expect(after.columns.map((x) => [x.physicalNm, x.domainId])).toEqual([['DOM_ID', null]]);

    const other = (
      await t.pool.query(
        "select table_id id from prj_table t join tf_project p using (project_id) where p.project_key = 'PRJB'",
      )
    ).rows[0].id as number;
    expect((await e.get(`${PA}/tables/${other}/history`)).status).toBe(404);
    expect((await e.post(`${PA}/tables/${other}/history/1/restore`, { version: 1 })).status).toBe(
      404,
    );
  });
});
