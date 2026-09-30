import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  TableCloneResponse,
  TableDetail,
  TableHistoryDetail,
  TableHistoryItem,
} from '@termflow/shared';
import { Client, createTestApp, setTestEnv } from './setup/app.js';
import { FIXTURE_PASSWORD, useTestDb } from './setup/databases.js';
import { insertUsers } from './setup/stdv1.js';

/**
 * 단계 8 복제(T8.6, 설계서 §8.4·§3.5.12·Q10): 같은 프로젝트(`_COPY`·`_COPY2`) · 다른 프로젝트(C7: 원본 조회자 + 대상 편집자,
 * 업무구분 biz_cd 기본 선택, 도메인·코드구분·기본컬럼 자연키 재매핑, 실패는 NULL + remapWarnings) · 이력 CLONE.
 * 데이터: rp33(RMS 33 테이블) + API로 만든 DEMO(RMS에서 업무구분·도메인분류·도메인·코드·기본컬럼 복사)·DEMO2(업무구분 RP만).
 * `pnpm test:db -- clone`
 */
const t = useTestDb('t_table_clone', { fixture: 'rp33' });
let app: INestApplication;
const P = '/api/v1/projects/RMS';
let users: Record<string, number> = {};
let srcId = 0;
let src: TableDetail;

beforeAll(async () => {
  users = await insertUsers(t.pool);
  for (const [login, role] of [
    ['pa', 'ADMIN'],
    ['editor', 'EDITOR'],
    ['viewer', 'VIEWER'],
  ] as const) {
    await t.pool.query(
      `insert into tf_project_member (project_id, user_id, member_role, created_by, updated_by)
       select project_id, $1, $2, 'SYSTEM', 'SYSTEM' from tf_project where project_key = 'RMS'`,
      [users[login], role],
    );
  }
  srcId = (
    await t.pool.query("select table_id id from prj_table where table_nm = 'RP_RSCH_PRJ_MST'")
  ).rows[0].id as number;
  setTestEnv(t.url);
  app = await createTestApp();
  const sa = await as('admin');
  const fromRms = { source: 'PROJECT', sourceKey: 'RMS' };
  const empty = { source: 'EMPTY' };
  const demo = await sa.post('/api/v1/projects', {
    projectKey: 'DEMO',
    projectNm: '데모',
    imports: {
      bizAreas: fromRms,
      terms: empty,
      domainClasses: fromRms,
      domains: fromRms,
      codes: fromRms,
      defaultColSets: fromRms,
    },
    members: [
      { userId: users['editor'], role: 'EDITOR' },
      { userId: users['viewer'], role: 'VIEWER' },
    ],
  });
  expect(demo.status, JSON.stringify(demo.body)).toBe(201);
  const demo2 = await sa.post('/api/v1/projects', {
    projectKey: 'DEMO2',
    projectNm: '데모2(표준 없음)',
    imports: {
      bizAreas: { ...fromRms, bizCds: ['RP'] },
      terms: empty,
      domainClasses: empty,
      domains: empty,
      codes: empty,
      defaultColSets: empty,
    },
    members: [{ userId: users['editor'], role: 'EDITOR' }],
  });
  expect(demo2.status, JSON.stringify(demo2.body)).toBe(201);
  src = (await sa.get(`${P}/tables/${srcId}`)).body as TableDetail;
});
afterAll(async () => {
  await app?.close();
});

async function as(login: string): Promise<Client> {
  const c = new Client(app.getHttpServer());
  expect((await c.login(login, FIXTURE_PASSWORD)).status).toBe(200);
  return c;
}
const refs = (d: TableDetail) => ({
  domain: d.columns.filter((c) => c.domainId !== null).length,
  code: d.columns.filter((c) => c.codeClsId !== null).length,
  dflt: d.columns.filter((c) => c.defaultColId !== null).length,
});

describe('같은 프로젝트 복제', () => {
  it('편집자: _COPY → _COPY2, DRAFT v1, 컬럼·참조 그대로, 이력 CLONE(원본 기록) / 조회자 403', async () => {
    const e = await as('editor');
    const r1 = await e.post(`${P}/tables/${srcId}/clone`, {});
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    const c1 = r1.body as TableCloneResponse;
    expect(c1).toMatchObject({
      projectKey: 'RMS',
      tableNm: 'RP_RSCH_PRJ_MST_COPY',
      version: 1,
      remapWarnings: [],
    });
    expect(c1.bizAreaId).toBe(src.table.bizAreaId);
    const r2 = await e.post(`${P}/tables/${srcId}/clone`, {});
    expect((r2.body as TableCloneResponse).tableNm).toBe('RP_RSCH_PRJ_MST_COPY2');

    const d = (await e.get(`${P}/tables/${c1.tableId}`)).body as TableDetail;
    expect(d.table).toMatchObject({
      status: 'DRAFT',
      version: 1,
      tableLogicalNm: src.table.tableLogicalNm,
    });
    expect(d.columns).toHaveLength(src.columns.length);
    expect(
      d.columns.map((c) => [
        c.physicalNm,
        c.dataType,
        c.dataLength,
        c.domainId,
        c.codeClsId,
        c.defaultColId,
        c.matchType,
      ]),
    ).toEqual(
      src.columns.map((c) => [
        c.physicalNm,
        c.dataType,
        c.dataLength,
        c.domainId,
        c.codeClsId,
        c.defaultColId,
        c.matchType,
      ]),
    );
    expect(d.columns.every((c, i) => c.columnId !== src.columns[i]!.columnId)).toBe(true);
    const h = (await e.get(`${P}/tables/${c1.tableId}/history`)).body as TableHistoryItem[];
    expect(h.map((x) => [x.version, x.action])).toEqual([[1, 'CLONE']]);
    const snap = ((await e.get(`${P}/tables/${c1.tableId}/history/1`)).body as TableHistoryDetail)
      .snapshot;
    expect(snap.clonedFrom).toEqual({
      projectKey: 'RMS',
      tableId: srcId,
      tableNm: 'RP_RSCH_PRJ_MST',
      version: 1,
    });
    expect(h[0]!.changeSummary).toBe('복제: RMS/RP_RSCH_PRJ_MST v1');

    const v = await as('viewer');
    expect((await v.post(`${P}/tables/${srcId}/clone`, {})).status).toBe(403);
  });

  it('이름 지정·업무구분 지정, 이름 중복 422 E_TABLE_NM_DUP, 형식 422, 다른 프로젝트 업무구분 422', async () => {
    const e = await as('editor');
    const ps = (
      await t.pool.query(
        "select biz_area_id id from prj_biz_area b join tf_project p using (project_id) where p.project_key = 'RMS' and b.biz_cd = 'PS'",
      )
    ).rows[0].id as number;
    const r = await e.post(`${P}/tables/${srcId}/clone`, {
      tableNm: 'ps_rsch_prj_mst',
      targetBizAreaId: ps,
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ tableNm: 'PS_RSCH_PRJ_MST', bizAreaId: ps });
    const dup = await e.post(`${P}/tables/${srcId}/clone`, { tableNm: 'PS_RSCH_PRJ_MST' });
    expect(dup.status).toBe(422);
    expect((dup.body as { errors: { code: string }[] }).errors[0]!.code).toBe('E_TABLE_NM_DUP');
    expect((await e.post(`${P}/tables/${srcId}/clone`, { tableNm: '1BAD' })).status).toBe(422);
    const demoRp = (
      await t.pool.query(
        "select biz_area_id id from prj_biz_area b join tf_project p using (project_id) where p.project_key = 'DEMO' and b.biz_cd = 'RP'",
      )
    ).rows[0].id as number;
    const x = await e.post(`${P}/tables/${srcId}/clone`, { targetBizAreaId: demoRp });
    expect(x.status).toBe(422);
    expect((x.body as { errors: { code: string }[] }).errors[0]!.code).toBe('E_BIZ_AREA_NOT_FOUND');
  });
});

describe('다른 프로젝트 복제(C7)', () => {
  it('RMS → DEMO: 이름 그대로(대상에 없음), 업무구분 RP 자동, 도메인·코드구분·기본컬럼 자연키 재매핑 전부 성공', async () => {
    const e = await as('editor');
    const r = await e.post(`${P}/tables/${srcId}/clone`, { targetProjectKey: 'DEMO' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const c = r.body as TableCloneResponse;
    expect(c).toMatchObject({ projectKey: 'DEMO', tableNm: 'RP_RSCH_PRJ_MST', remapWarnings: [] });
    const d = (await e.get(`/api/v1/projects/DEMO/tables/${c.tableId}`)).body as TableDetail;
    expect(d.table.bizCd).toBe('RP');
    const want = refs(src);
    expect(want.domain + want.code + want.dflt).toBeGreaterThan(0);
    expect(refs(d)).toEqual(want);
    // 재매핑된 ID는 모두 DEMO 소속, 자연키(도메인 논리명·코드구분·기본컬럼 물리명)가 원본과 같다
    const demoId = (
      await t.pool.query("select project_id id from tf_project where project_key = 'DEMO'")
    ).rows[0].id as number;
    const own = async (table: string, col: string, list: number[]) =>
      (
        await t.pool.query(
          `select count(*)::int n from ${table} where project_id = $1 and ${col} = any($2::int[])`,
          [demoId, list],
        )
      ).rows[0].n as number;
    const nn = (v: (number | null)[]) => v.filter((x): x is number => x !== null);
    expect(await own('std_domain', 'domain_id', nn(d.columns.map((x) => x.domainId)))).toBe(
      new Set(nn(d.columns.map((x) => x.domainId))).size,
    );
    expect(d.columns.map((x) => x.domainNm)).toEqual(src.columns.map((x) => x.domainNm));
    expect(d.columns.map((x) => x.codeCls && `${x.codeCls.bizCd}/${x.codeCls.codeCls}`)).toEqual(
      src.columns.map((x) => x.codeCls && `${x.codeCls.bizCd}/${x.codeCls.codeCls}`),
    );
    expect(d.columns.map((x) => x.physicalNm)).toEqual(src.columns.map((x) => x.physicalNm));
    const snap = (
      (await e.get(`/api/v1/projects/DEMO/tables/${c.tableId}/history/1`))
        .body as TableHistoryDetail
    ).snapshot;
    expect(snap).toMatchObject({
      action: 'CLONE',
      clonedFrom: { projectKey: 'RMS', tableId: srcId },
    });
    expect(snap.table.projectKey).toBe('DEMO');
    // 두 번째 복제는 이름이 겹치므로 _COPY
    const again = await e.post(`${P}/tables/${srcId}/clone`, { targetProjectKey: 'DEMO' });
    expect((again.body as TableCloneResponse).tableNm).toBe('RP_RSCH_PRJ_MST_COPY');
  });

  it('RMS → DEMO2(표준 없음): 참조 전부 NULL + remapWarnings(행·필드·자연키)', async () => {
    const e = await as('editor');
    const r = await e.post(`${P}/tables/${srcId}/clone`, { targetProjectKey: 'DEMO2' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const c = r.body as TableCloneResponse;
    const want = refs(src);
    expect(c.remapWarnings).toHaveLength(want.domain + want.code + want.dflt);
    const kinds = (k: string) => c.remapWarnings.filter((w) => w.code === k).length;
    expect([
      kinds('W_REMAP_DOMAIN'),
      kinds('W_REMAP_CODE_CLS'),
      kinds('W_REMAP_DEFAULT_COL'),
    ]).toEqual([want.domain, want.code, want.dflt]);
    const w = c.remapWarnings[0]!;
    expect(w.columnNm).toBe(src.columns[w.rowIndex]!.physicalNm);
    expect(w.message).toContain(w.sourceKey);
    const d = (await e.get(`/api/v1/projects/DEMO2/tables/${c.tableId}`)).body as TableDetail;
    expect(refs(d)).toEqual({ domain: 0, code: 0, dflt: 0 });
    const h = (await e.get(`/api/v1/projects/DEMO2/tables/${c.tableId}/history`))
      .body as TableHistoryItem[];
    expect(h[0]!.changeSummary).toBe(
      `복제: RMS/RP_RSCH_PRJ_MST v1 · 재매핑 실패 ${c.remapWarnings.length}`,
    );
  });

  it('대상 권한: 비멤버 404 · 대상 조회자 403 · 대상 업무구분 없음 422 · 템플릿 409 · 원본 조회자는 다른 프로젝트 편집자면 허용', async () => {
    const pa = await as('pa'); // RMS 관리자, DEMO 비멤버
    expect((await pa.post(`${P}/tables/${srcId}/clone`, { targetProjectKey: 'DEMO' })).status).toBe(
      404,
    );
    expect((await pa.post(`${P}/tables/${srcId}/clone`, { targetProjectKey: 'NONE' })).status).toBe(
      404,
    );
    const v = await as('viewer'); // RMS 조회자 · DEMO 조회자
    expect((await v.post(`${P}/tables/${srcId}/clone`, { targetProjectKey: 'DEMO' })).status).toBe(
      403,
    );
    // 원본 조회자 + 대상 편집자 → 허용(§8.4)
    await t.pool.query(
      "update tf_project_member set member_role = 'EDITOR' where user_id = $1 and project_id = (select project_id from tf_project where project_key = 'DEMO')",
      [users['viewer']],
    );
    const ok = await v.post(`${P}/tables/${srcId}/clone`, {
      targetProjectKey: 'DEMO',
      tableNm: 'RP_BY_VIEWER',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    // DEMO2에는 업무구분 AC가 없다 → AC 테이블 복제는 업무구분 선택 필수 422
    const ac = (
      await t.pool.query(
        "select biz_area_id id from prj_biz_area b join tf_project p using (project_id) where p.project_key = 'RMS' and b.biz_cd = 'AC'",
      )
    ).rows[0].id as number;
    const e = await as('editor');
    const acTable = await e.post(`${P}/tables`, {
      table: {
        bizAreaId: ac,
        tableNm: 'AC_CLONE_SRC',
        tableLogicalNm: '회계 원본',
        description: null,
      },
      columns: [
        {
          columnId: null,
          logicalNm: '아이디',
          physicalNm: 'AC_ID',
          dataType: 'INT',
          colComment: '아이디',
        },
      ],
    });
    expect(acTable.status, JSON.stringify(acTable.body)).toBe(201);
    const noBiz = await e.post(
      `${P}/tables/${(acTable.body as { tableId: number }).tableId}/clone`,
      { targetProjectKey: 'DEMO2' },
    );
    expect(noBiz.status).toBe(422);
    expect((noBiz.body as { errors: { code: string }[] }).errors[0]!.code).toBe(
      'E_BIZ_AREA_REQUIRED',
    );
    // 템플릿 대상(SA만 보임) → 409
    await t.pool.query(
      "insert into tf_project (project_key, project_nm, kind, created_by, updated_by) values ('TPLX', '템플릿', 'TEMPLATE', 'SYSTEM', 'SYSTEM')",
    );
    const sa = await as('admin');
    const tpl = await sa.post(`${P}/tables/${srcId}/clone`, { targetProjectKey: 'TPLX' });
    expect(tpl.status).toBe(409);
    expect(tpl.body).toMatchObject({ code: 'E_TEMPLATE_NO_TABLES' });
    expect((await e.post(`${P}/tables/${srcId}/clone`, { targetProjectKey: 'TPLX' })).status).toBe(
      404,
    );
  });
});
