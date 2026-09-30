import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DdlResponse, TableDetail, TableSaveResponse } from '@termflow/shared';
import { Client, createTestApp, setTestEnv } from './setup/app.js';
import { FIXTURE_PASSWORD, useTestDb } from './setup/databases.js';
import { perfLimit } from './setup/perf.js';
import { insertUsers } from './setup/stdv1.js';

/**
 * 단계 8 RMS 실데이터(T8.15): 편집기 로드 36컬럼 500ms(§12.1), 승계 FINAL 테이블 → 확정 해제 → 기본컬럼 제외 저장 → DDL에서 빠짐(T8.10 DoD).
 * 데이터: rp33(승계 완료 RMS 33 테이블). `pnpm test:db -- table-rms`
 */
const t = useTestDb('t_table_rms', { fixture: 'rp33' });
let app: INestApplication;
const P = '/api/v1/projects/RMS';
let mstId = 0;

beforeAll(async () => {
  const users = await insertUsers(t.pool);
  for (const [login, role] of [
    ['pa', 'ADMIN'],
    ['editor', 'EDITOR'],
  ] as const) {
    await t.pool.query(
      `insert into tf_project_member (project_id, user_id, member_role, created_by, updated_by)
       select project_id, $1, $2, 'SYSTEM', 'SYSTEM' from tf_project where project_key = 'RMS'`,
      [users[login], role],
    );
  }
  mstId = (
    await t.pool.query("select table_id id from prj_table where table_nm = 'RP_RSCH_PRJ_MST'")
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

describe('RMS 실데이터 편집기(T8.15)', () => {
  it('편집기 로드(GET P/tables/{id}) RP_RSCH_PRJ_MST 36컬럼 p95 500ms 이내', async () => {
    const e = await as('editor');
    const times: number[] = [];
    let d: TableDetail | null = null;
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      const r = await e.get(`${P}/tables/${mstId}`);
      times.push(performance.now() - t0);
      expect(r.status).toBe(200);
      d = r.body as TableDetail;
    }
    expect(d!.columns).toHaveLength(36);
    expect(d!.table).toMatchObject({ status: 'FINAL', updatedBy: 'MIGRATION' });
    expect(d!.errors).toEqual([]);
    const sorted = [...times].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
    process.stderr.write(
      `[table-rms] 편집기 로드 36컬럼 p95 ${p95.toFixed(0)}ms · 중앙값 ${sorted[10]!.toFixed(0)}ms\n`,
    );
    expect(p95).toBeLessThan(perfLimit(500, 1500));
  });

  it('승계 FINAL → PA 확정 해제 → 변경 없는 저장은 "컬럼 +0 ~0 -0" → 기본컬럼 1개 제외 저장 → DDL에서 빠짐', async () => {
    const pa = await as('pa');
    const e = await as('editor');
    const d0 = (await e.get(`${P}/tables/${mstId}`)).body as TableDetail;
    const u = await pa.put(`${P}/tables/${mstId}/status`, {
      status: 'DRAFT',
      version: d0.table.version,
      note: '편집기 시험',
    });
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    const d1 = (await e.get(`${P}/tables/${mstId}`)).body as TableDetail;
    const same = await e.put(`${P}/tables/${mstId}`, toBody(d1));
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    expect((same.body as TableSaveResponse).changeSummary).toBe('컬럼 +0 ~0 -0');

    const d2 = (await e.get(`${P}/tables/${mstId}`)).body as TableDetail;
    const dflt = d2.columns.filter((c) => c.defaultColId !== null);
    expect(dflt.length).toBeGreaterThan(0);
    const drop = dflt.at(-1)!.physicalNm;
    const b = toBody(d2);
    const r = await e.put(`${P}/tables/${mstId}`, {
      ...b,
      columns: b.columns.filter((c) => c.physicalNm !== drop),
    });
    expect(r.status).toBe(200);
    expect((r.body as TableSaveResponse).changeSummary).toBe('컬럼 +0 ~0 -1');
    const ddl = (await e.post(`${P}/ddl`, { tableIds: [mstId] })).body as DdlResponse;
    expect(ddl.tables[0]!.sql).not.toMatch(new RegExp(`\\b${drop}\\b`));
    expect(ddl.tables[0]!.colCnt).toBe(35);
  });
});
