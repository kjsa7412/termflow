import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CopySourcesResponse, ProjectCreateResponse, TemplateItem } from '@termflow/shared';
import { Client, createTestApp, setTestEnv } from './setup/app.js';
import { FIXTURE_PASSWORD, useTestDb } from './setup/databases.js';

// T5.8 템플릿 API: 목록(건수·파생 수)·게시(PUBLISH, 승인 용어만 기본)·보관·삭제(사용 중 409)·비SA 404/403
const t = useTestDb('t_template', { fixture: 'std_small' });
let app: INestApplication;

beforeAll(async () => {
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
const find = (list: TemplateItem[], key: string) => list.find((x) => x.key === key)!;

describe('템플릿(T5.8)', () => {
  it('목록: 건수·파생 프로젝트 수, 시스템 관리자 전용', async () => {
    const sa = await as('sysadmin');
    const r = await sa.get('/api/v1/admin/templates');
    expect(r.status).toBe(200);
    const stds = find(r.body, 'STDS');
    expect(stds.counts).toEqual({
      bizArea: 2,
      term: 50,
      termApproved: 48,
      domainCls: 20,
      domain: 100,
      codeCls: 5,
      code: 30,
      defaultColSet: 1,
      defaultCol: 9,
    });
    expect(stds.derivedCnt).toBe(1); // PRJA(copied_from)
    expect((await (await as('pa')).get('/api/v1/admin/templates')).status).toBe(403);
  });

  it('게시: 승인 용어만(기본) → 용어 48, kind TEMPLATE·멤버 없음·PUBLISH 로그 8행, 원본 변경 없음', async () => {
    const sa = await as('sysadmin');
    const before = await t.pool.query(
      "select count(*)::int n from std_term t join tf_project p using (project_id) where p.project_key = 'PRJA'",
    );
    const r = await sa.post('/api/v1/admin/templates', {
      sourceProjectKey: 'PRJA',
      projectKey: 'TPLA',
      projectNm: '프로젝트 A 표준 v1',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const out = r.body as ProjectCreateResponse;
    expect(Object.fromEntries(out.items.map((i) => [i.item, i.copied]))).toMatchObject({
      BIZ_AREA: 2,
      TERM: 48,
      DOMAIN: 100,
      CODE: 30,
      DEFAULT_COL: 9,
    });
    expect(out.items.find((i) => i.item === 'TERM')).toMatchObject({
      sourceKind: 'PROJECT',
      sourceKey: 'PRJA',
      skipped: 2,
    });
    const p = await t.pool.query(
      `select p.kind, p.status, (select count(*) from tf_project_member m where m.project_id = p.project_id)::int members,
              (select count(*) from project_copy_log l where l.project_id = p.project_id and l.operation = 'PUBLISH')::int logs,
              f.project_key from_key
         from tf_project p left join tf_project f on f.project_id = p.copied_from_project_id where p.project_key = 'TPLA'`,
    );
    expect(p.rows[0]).toEqual({
      kind: 'TEMPLATE',
      status: 'ACTIVE',
      members: 0,
      logs: 8,
      from_key: 'PRJA',
    });
    const after = await t.pool.query(
      "select count(*)::int n from std_term t join tf_project p using (project_id) where p.project_key = 'PRJA'",
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    // 승인 용어만 끄면 PENDING도 상태 그대로
    const all = await sa.post('/api/v1/admin/templates', {
      sourceProjectKey: 'PRJA',
      projectKey: 'TPLALL',
      projectNm: '전체 용어',
      approvedOnly: false,
    });
    expect(all.body.items.find((i: { item: string }) => i.item === 'TERM').copied).toBe(50);
    const pend = await t.pool.query(
      "select count(*)::int n from std_term t join tf_project p using (project_id) where p.project_key = 'TPLALL' and t.status = 'PENDING'",
    );
    expect(pend.rows[0]).toEqual({ n: 2 });
    const dup = await sa.post('/api/v1/admin/templates', {
      sourceProjectKey: 'PRJA',
      projectKey: 'TPLA',
      projectNm: 'x',
    });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('E_PROJECT_KEY_DUP');
  });

  it('템플릿의 멤버 API 409 E_TEMPLATE_NO_TABLES, 비SA는 템플릿 P/** 404', async () => {
    const sa = await as('sysadmin');
    const m = await sa.post('/api/v1/projects/TPLA/members', { userId: 1, role: 'VIEWER' });
    expect(m.status).toBe(409);
    expect(m.body.code).toBe('E_TEMPLATE_NO_TABLES');
    expect((await (await as('pa')).get('/api/v1/projects/TPLA')).status).toBe(404);
    expect((await (await as('pa')).get('/api/v1/projects/TPLA/biz-areas')).status).toBe(404);
  });

  it('보관: 마법사 원본 후보에서 숨김 → 복원', async () => {
    const sa = await as('sysadmin');
    expect(
      (await sa.put('/api/v1/admin/templates/TPLA/status', { status: 'ARCHIVED' })).body.status,
    ).toBe('ARCHIVED');
    const src = (await sa.get('/api/v1/projects/copy-sources')).body as CopySourcesResponse;
    expect(src.templates.map((x) => x.key)).not.toContain('TPLA');
    expect(
      (await sa.put('/api/v1/admin/templates/TPLA/status', { status: 'ACTIVE' })).body.status,
    ).toBe('ACTIVE');
    expect(
      (await sa.put('/api/v1/admin/templates/PRJA/status', { status: 'ARCHIVED' })).status,
    ).toBe(404);
  });

  it('삭제: 사용 중(파생 있음) 409 E_TEMPLATE_IN_USE, 키 불일치 422, 파생 없으면 204', async () => {
    const sa = await as('sysadmin');
    // TPLA로 프로젝트를 만들면 사용 중
    const imp = { source: 'TEMPLATE', sourceKey: 'TPLA' };
    const created = await sa.post('/api/v1/projects', {
      projectKey: 'FROMT',
      projectNm: 'TPLA 파생',
      imports: {
        bizAreas: imp,
        terms: imp,
        domainClasses: imp,
        domains: imp,
        codes: imp,
        defaultColSets: imp,
      },
    });
    expect(created.status).toBe(201);
    const inUse = await sa.delete('/api/v1/admin/templates/TPLA', { confirmKey: 'TPLA' });
    expect(inUse.status).toBe(409);
    expect(inUse.body).toMatchObject({ code: 'E_TEMPLATE_IN_USE', derivedCnt: 1 });
    expect(
      (await sa.delete('/api/v1/admin/templates/STDS', { confirmKey: 'STDS' })).body.code,
    ).toBe('E_TEMPLATE_IN_USE');
    expect((await sa.delete('/api/v1/admin/templates/TPLALL', { confirmKey: 'TPLA' })).status).toBe(
      422,
    );
    expect(
      (await sa.delete('/api/v1/admin/templates/TPLALL', { confirmKey: 'TPLALL' })).status,
    ).toBe(204);
    const list = (await sa.get('/api/v1/admin/templates')).body as TemplateItem[];
    expect(list.map((x) => x.key).sort()).toEqual(['STDS', 'TPLA']);
    expect(find(list, 'TPLA').derivedCnt).toBe(1);
  });
});
