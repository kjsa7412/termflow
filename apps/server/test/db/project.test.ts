import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AdminProjectItem,
  MemberCandidate,
  MemberItem,
  ProjectCard,
  ProjectHome,
  ProjectSettings,
} from '@termflow/shared';
import { Client, createTestApp, setTestEnv } from './setup/app.js';
import { FIXTURE_PASSWORD, useTestDb } from './setup/databases.js';

// T5.1 프로젝트 API · T5.5 시스템 프로젝트(보관·복원·삭제) · T5.6 멤버(마지막 프로젝트 관리자 409)
const t = useTestDb('t_project', { fixture: 'std_small' });
let app: INestApplication;
const ids: Record<string, number> = {};

beforeAll(async () => {
  await t.pool
    .query(`insert into tf_user (login_id, user_nm, password_hash, is_active, pw_change_required, created_by, updated_by)
    select v.login_id, v.nm, u.password_hash, v.active, false, 'SYSTEM', 'SYSTEM'
      from (values ('nobody', '무소속', true), ('gone', '퇴사자', false), ('pa2', '관리자2', true)) v(login_id, nm, active)
      cross join (select password_hash from tf_user where login_id = 'viewer') u`);
  const { rows } = await t.pool.query('select login_id, user_id from tf_user');
  for (const r of rows) ids[r.login_id as string] = r.user_id as number;
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

describe('GET /projects(T5.1): 소속만·SA 전체·템플릿 제외', () => {
  it('시스템 관리자 전체(멤버 아님 표시), PA 둘, 편집자 PRJA만, 무소속 빈 목록', async () => {
    const sa = (await (await as('sysadmin')).get('/api/v1/projects')).body as ProjectCard[];
    expect(sa.map((p) => p.key)).toEqual(['PRJA', 'PRJB']);
    expect(sa[0]).toMatchObject({
      myRole: 'ADMIN',
      isMember: false,
      tableCnt: 1,
      memberCnt: 3,
      status: 'ACTIVE',
    });
    expect(sa[0]!.bizAreas).toEqual([
      { bizCd: 'RP', bizNm: '연구과제', tableCnt: 1, useYn: true },
      { bizCd: 'PS', bizNm: '인사', tableCnt: 0, useYn: true },
    ]);
    expect(sa[0]!.lastChangedBy).toBe('editor');
    const pa = (await (await as('pa')).get('/api/v1/projects')).body as ProjectCard[];
    expect(pa.map((p) => [p.key, p.myRole, p.isMember])).toEqual([
      ['PRJA', 'ADMIN', true],
      ['PRJB', 'ADMIN', true],
    ]);
    const ed = (await (await as('editor')).get('/api/v1/projects?q=prj')).body as ProjectCard[];
    expect(ed.map((p) => [p.key, p.myRole])).toEqual([['PRJA', 'EDITOR']]);
    expect((await (await as('nobody')).get('/api/v1/projects')).body).toEqual([]);
    const mine = await (await as('sysadmin')).get('/api/v1/projects?mine=true');
    expect(mine.body).toEqual([]);
  });

  it('check-key: 형식·중복(템플릿 키 포함), 시스템 관리자 전용', async () => {
    const sa = await as('sysadmin');
    expect((await sa.get('/api/v1/projects/check-key?key=NEW1')).body).toEqual({ available: true });
    expect((await sa.get('/api/v1/projects/check-key?key=STDS')).body).toMatchObject({
      available: false,
    });
    expect((await sa.get('/api/v1/projects/check-key?key=1AB')).body.reason).toContain(
      '영문 대문자',
    );
    expect((await sa.get('/api/v1/projects/check-key?key=ABCDEFGHIJK')).body.available).toBe(false);
    expect((await (await as('pa')).get('/api/v1/projects/check-key?key=NEW1')).status).toBe(403);
  });
});

describe('GET P · P/settings(T5.1)', () => {
  it('홈 요약: 업무구분별·상태별 테이블 수, 내 역할, 검토 도메인·PENDING 용어 수', async () => {
    const r = await (await as('viewer')).get('/api/v1/projects/PRJA');
    expect(r.status).toBe(200);
    const h = r.body as ProjectHome;
    expect(h.myRole).toBe('VIEWER');
    expect(h.project).toMatchObject({
      key: 'PRJA',
      kind: 'PROJECT',
      status: 'ACTIVE',
      defaultColSetNm: '기본',
    });
    expect(h.project.copiedFrom).toEqual({ key: 'STDS', nm: '소형 표준 템플릿' });
    expect(h.tables).toEqual({ total: 1, draft: 1, final: 0, review: 0 });
    expect(h.bizAreas.map((b) => [b.bizCd, b.tableCnt])).toEqual([
      ['RP', 1],
      ['PS', 0],
    ]);
    expect(h.reviewDomainCnt).toBe(4);
    expect(h.pendingTermCnt).toBe(2);
    expect(h.memberCnt).toBe(3);
  });

  it('비멤버·없는 키 404, 템플릿은 SA만(그 외 404)', async () => {
    expect((await (await as('editor')).get('/api/v1/projects/PRJB')).status).toBe(404);
    expect((await (await as('pa')).get('/api/v1/projects/NOPE')).status).toBe(404);
    expect((await (await as('pa')).get('/api/v1/projects/STDS')).status).toBe(404);
    expect((await (await as('sysadmin')).get('/api/v1/projects/STDS')).status).toBe(200);
  });

  it('설정: 조회자 GET, PA PUT(키 변경 불가), 다른 프로젝트 기본컬럼 세트 422, 편집자 PUT 403', async () => {
    const v = await as('viewer');
    const s = (await v.get('/api/v1/projects/PRJA/settings')).body as ProjectSettings;
    expect(s).toMatchObject({
      projectKey: 'PRJA',
      includeDefaultCols: true,
      defaultDialect: 'POSTGRESQL',
    });
    expect(s.defaultColSets).toHaveLength(1);
    expect(s.defaultColSets[0]!.columns).toHaveLength(9);
    expect(s.defaultColSets[0]!.columns[2]).toMatchObject({
      physicalNm: 'FIRS_REG_DTS',
      typeText: 'TIMESTAMP(0)',
    });
    const pa = await as('pa');
    const body = {
      projectNm: '프로젝트 A(개명)',
      description: '설명',
      defaultDialect: 'POSTGRESQL',
      includeDefaultCols: false,
      defaultColSetId: s.defaultColSetId,
      projectKey: 'HACK',
    };
    const put = await pa.put('/api/v1/projects/PRJA/settings', body);
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({
      projectKey: 'PRJA',
      projectNm: '프로젝트 A(개명)',
      includeDefaultCols: false,
    });
    const other = (await pa.get('/api/v1/projects/PRJB/settings')).body as ProjectSettings;
    const bad = await pa.put('/api/v1/projects/PRJA/settings', {
      ...body,
      defaultColSetId: other.defaultColSetId,
    });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0].code).toBe('E_DEFAULT_COL_SET_NOT_FOUND');
    expect((await (await as('editor')).put('/api/v1/projects/PRJA/settings', body)).status).toBe(
      403,
    );
    const u = await t.pool.query("select updated_by from tf_project where project_key = 'PRJA'");
    expect(u.rows[0]).toEqual({ updated_by: 'pa' });
  });
});

describe('멤버(T5.6)', () => {
  it('목록(조회자)·후보 검색(PA, 활성·멤버 표시)', async () => {
    const list = (await (await as('viewer')).get('/api/v1/projects/PRJA/members'))
      .body as MemberItem[];
    expect(list.map((m) => [m.loginId, m.role])).toEqual([
      ['pa', 'ADMIN'],
      ['editor', 'EDITOR'],
      ['viewer', 'VIEWER'],
    ]);
    const pa = await as('pa');
    const cand = (await pa.get('/api/v1/projects/PRJA/member-candidates?q='))
      .body as MemberCandidate[];
    expect(cand.find((c) => c.loginId === 'nobody')).toMatchObject({ isMember: false });
    expect(cand.find((c) => c.loginId === 'editor')).toMatchObject({ isMember: true });
    expect(cand.some((c) => c.loginId === 'gone')).toBe(false);
    expect((await (await as('editor')).get('/api/v1/projects/PRJA/member-candidates')).status).toBe(
      403,
    );
  });

  it('추가 201 → 중복 409 E_MEMBER_DUP, 비활성 422, 역할 변경, 제외 204', async () => {
    const pa = await as('pa');
    const add = await pa.post('/api/v1/projects/PRJA/members', {
      userId: ids['nobody'],
      role: 'VIEWER',
    });
    expect(add.status).toBe(201);
    expect(add.body).toMatchObject({ loginId: 'nobody', role: 'VIEWER' });
    const dup = await pa.post('/api/v1/projects/PRJA/members', {
      userId: ids['nobody'],
      role: 'EDITOR',
    });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('E_MEMBER_DUP');
    const inactive = await pa.post('/api/v1/projects/PRJA/members', {
      userId: ids['gone'],
      role: 'VIEWER',
    });
    expect(inactive.status).toBe(422);
    const up = await pa.put(`/api/v1/projects/PRJA/members/${ids['nobody']}`, { role: 'EDITOR' });
    expect(up.status).toBe(200);
    expect(up.body.role).toBe('EDITOR');
    // 역할 변경은 다음 요청부터 권한에 반영(가드가 요청마다 멤버십을 읽는다)
    const nb = await as('nobody');
    expect((await nb.get('/api/v1/projects/PRJA')).body.myRole).toBe('EDITOR');
    expect((await pa.delete(`/api/v1/projects/PRJA/members/${ids['nobody']}`)).status).toBe(204);
    expect((await nb.get('/api/v1/projects/PRJA')).status).toBe(404);
    expect((await pa.delete(`/api/v1/projects/PRJA/members/${ids['nobody']}`)).status).toBe(404);
  });

  it('마지막 프로젝트 관리자 강등·제거 409 E_LAST_PROJECT_ADMIN, 관리자 2명이면 가능(CR-01-4)', async () => {
    const pa = await as('pa');
    const demote = await pa.put(`/api/v1/projects/PRJB/members/${ids['pa']}`, { role: 'EDITOR' });
    expect(demote.status).toBe(409);
    expect(demote.body.code).toBe('E_LAST_PROJECT_ADMIN');
    const rm = await pa.delete(`/api/v1/projects/PRJB/members/${ids['pa']}`);
    expect(rm.status).toBe(409);
    expect(
      (await pa.post('/api/v1/projects/PRJB/members', { userId: ids['pa2'], role: 'ADMIN' }))
        .status,
    ).toBe(201);
    expect(
      (await pa.put(`/api/v1/projects/PRJB/members/${ids['pa']}`, { role: 'EDITOR' })).status,
    ).toBe(200);
    const back = await as('pa2');
    expect(
      (await back.put(`/api/v1/projects/PRJB/members/${ids['pa']}`, { role: 'ADMIN' })).status,
    ).toBe(200);
  });

  it('템플릿의 멤버 API는 409 E_TEMPLATE_NO_TABLES(SA)', async () => {
    const r = await (await as('sysadmin')).get('/api/v1/projects/STDS/members');
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('E_TEMPLATE_NO_TABLES');
  });
});

describe('시스템 › 프로젝트(T5.5): 보관·복원·삭제', () => {
  it('보관 → 모든 쓰기 409 E_PROJECT_READONLY·목록 기본 숨김 → 복원', async () => {
    const sa = await as('sysadmin');
    const list = (await sa.get('/api/v1/admin/projects')).body as AdminProjectItem[];
    expect(list.map((p) => p.key)).toEqual(['PRJA', 'PRJB']);
    expect(list[0]).toMatchObject({
      memberCnt: 3,
      tableCnt: 1,
      bizCds: ['RP', 'PS'],
      copiedFrom: { key: 'STDS' },
    });
    const arch = await sa.put('/api/v1/admin/projects/PRJB/status', { status: 'ARCHIVED' });
    expect(arch.status).toBe(200);
    expect(arch.body.status).toBe('ARCHIVED');
    const pa = await as('pa');
    const w = await pa.put('/api/v1/projects/PRJB/settings', {
      projectNm: 'x',
      description: null,
      defaultDialect: 'POSTGRESQL',
      includeDefaultCols: true,
      defaultColSetId: null,
    });
    expect(w.status).toBe(409);
    expect(w.body.code).toBe('E_PROJECT_READONLY');
    expect(
      (await pa.post('/api/v1/projects/PRJB/members', { userId: ids['nobody'], role: 'VIEWER' }))
        .body.code,
    ).toBe('E_PROJECT_READONLY');
    expect((await pa.get('/api/v1/projects/PRJB')).status).toBe(200);
    expect(((await pa.get('/api/v1/projects')).body as ProjectCard[]).map((p) => p.key)).toEqual([
      'PRJA',
    ]);
    expect(
      ((await pa.get('/api/v1/projects?includeArchived=true')).body as ProjectCard[]).map(
        (p) => p.key,
      ),
    ).toEqual(['PRJA', 'PRJB']);
    expect(
      (await sa.put('/api/v1/admin/projects/PRJB/status', { status: 'ACTIVE' })).body.status,
    ).toBe('ACTIVE');
    expect(
      (await sa.put('/api/v1/admin/projects/STDS/status', { status: 'ARCHIVED' })).status,
    ).toBe(404);
  });

  it('삭제: ACTIVE 409 E_PROJECT_ACTIVE, 키 불일치 422, 보관 후 키 재입력 204 → CASCADE·origin SET NULL', async () => {
    const sa = await as('sysadmin');
    const active = await sa.delete('/api/v1/admin/projects/PRJB', { confirmKey: 'PRJB' });
    expect(active.status).toBe(409);
    expect(active.body.code).toBe('E_PROJECT_ACTIVE');
    await sa.put('/api/v1/admin/projects/PRJB/status', { status: 'ARCHIVED' });
    const wrong = await sa.delete('/api/v1/admin/projects/PRJB', { confirmKey: 'PRJA' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.errors[0].code).toBe('E_CONFIRM_KEY_MISMATCH');
    expect((await sa.delete('/api/v1/admin/projects/PRJB', { confirmKey: 'PRJB' })).status).toBe(
      204,
    );
    const left = await t.pool.query(
      "select (select count(*) from tf_project where project_key = 'PRJB')::int p, (select count(*) from std_term where project_id not in (select project_id from tf_project))::int orphan",
    );
    expect(left.rows[0]).toEqual({ p: 0, orphan: 0 });
    expect(
      (await (await as('pa')).delete('/api/v1/admin/projects/PRJA', { confirmKey: 'PRJA' })).status,
    ).toBe(403);
  });
});
