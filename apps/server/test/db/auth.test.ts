import {
  Controller,
  Get,
  Logger,
  Module,
  Post,
  Put,
  Req,
  type INestApplication,
} from '@nestjs/common';
import express from 'express';
import session from 'express-session';
import type { Request } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Public, ProjectRole, SysAdmin } from '../../src/auth/decorators.js';
import { sessionMiddleware } from '../../src/auth/http-security.js';
import { Client, createTestApp, setTestEnv } from './setup/app.js';
import { FIXTURE_PASSWORD, useTestDb } from './setup/databases.js';

// T4.1~T4.6 API 통합(실 DB, std_small 픽스처: sysadmin·pa·editor·viewer, 템플릿 STDS, 프로젝트 PRJA·PRJB)

@Controller('dummy')
class DummyController {
  @Public()
  @Get('public')
  open() {
    return { ok: true };
  }

  @Get('any')
  any(@Req() req: Request) {
    return { user: req.authUser?.loginId };
  }

  @SysAdmin()
  @Get('sys')
  sys() {
    return { ok: true };
  }
}

@Controller('projects/:projectKey/dummy')
class DummyProjectController {
  @ProjectRole('VIEWER')
  @Get()
  read(@Req() req: Request) {
    return req.projectCtx;
  }

  @ProjectRole('EDITOR')
  @Post()
  write(@Req() req: Request) {
    return req.projectCtx;
  }

  @ProjectRole('ADMIN')
  @Put('settings')
  admin(@Req() req: Request) {
    return req.projectCtx;
  }
}

@Module({ controllers: [DummyController, DummyProjectController] })
class DummyModule {}

const t = useTestDb('t_auth', { fixture: 'std_small' });
let app: INestApplication;
const warn = vi.spyOn(Logger.prototype, 'warn');
const log = vi.spyOn(Logger.prototype, 'log');
const allLogText = () =>
  [...warn.mock.calls, ...log.mock.calls].map((c) => c.map(String).join(' ')).join('\n');

beforeAll(async () => {
  setTestEnv(t.url);
  app = await createTestApp([DummyModule]);
});
afterAll(async () => {
  await app?.close();
});
beforeEach(async () => {
  await t.pool.query('update tf_user set login_fail_cnt = 0, locked_until = null');
});

const server = () => app.getHttpServer();
const newClient = () => new Client(server());
async function loggedIn(loginId: string, password = FIXTURE_PASSWORD): Promise<Client> {
  const c = newClient();
  const res = await c.login(loginId, password);
  expect(res.status).toBe(200);
  return c;
}

describe('T4.1 세션·CSRF·보안 헤더', () => {
  it('tf.sid: HttpOnly·SameSite=Lax·Path=/·60분, XSRF-TOKEN은 HttpOnly 아님', async () => {
    const res = await request(server()).get('/api/v1/auth/csrf').expect(200);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    const sid = cookies.find((c) => c.startsWith('tf.sid='))!;
    expect(sid).toMatch(/HttpOnly/i);
    expect(sid).toMatch(/SameSite=Lax/i);
    expect(sid).toMatch(/Path=\//);
    expect(sid).not.toMatch(/Secure/i); // test·dev는 http
    const expires = new Date(/Expires=([^;]+)/i.exec(sid)![1]!).getTime();
    expect(Math.abs(expires - Date.now() - 60 * 60_000)).toBeLessThan(60_000);
    const xsrf = cookies.find((c) => c.startsWith('XSRF-TOKEN='))!;
    expect(xsrf).not.toMatch(/HttpOnly/i);
    expect((res.body as { token: string }).token.length).toBeGreaterThan(20);
  });

  it('보안 헤더: CSP script-src self(unsafe-eval 없음)·nosniff·X-Frame-Options DENY', async () => {
    const res = await request(server()).get('/api/v1/auth/csrf');
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('prod 쿠키는 Secure(프록시 X-Forwarded-Proto: https, trust proxy)', async () => {
    const e = express();
    e.set('trust proxy', 1);
    e.use(
      sessionMiddleware(
        {
          NODE_ENV: 'production',
          TERMFLOW_SESSION_SECRET: 'x'.repeat(40),
          TERMFLOW_SESSION_TIMEOUT: '60m',
        },
        new session.MemoryStore(),
      ),
    );
    e.get('/', (req, res) => {
      req.session.anon = true;
      res.send('ok');
    });
    const res = await request(e).get('/').set('X-Forwarded-Proto', 'https');
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toMatch(/; Secure/);
  });

  it('CSRF 헤더 누락·불일치 → 403 type csrf(ProblemDetail)', async () => {
    const c = newClient();
    await c.fetchCsrf();
    const res = await c.post(
      '/api/v1/auth/login',
      { loginId: 'editor', password: FIXTURE_PASSWORD },
      { form: true, csrf: false },
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      type: expect.stringMatching(/\/csrf$/),
      status: 403,
      code: 'E_CSRF',
    });
    c.csrf = 'forged-token';
    expect(
      (
        await c.post(
          '/api/v1/auth/login',
          { loginId: 'editor', password: FIXTURE_PASSWORD },
          { form: true },
        )
      ).status,
    ).toBe(403);
  });
});

describe('T4.2 로그인·로그아웃·잠금', () => {
  it('성공: form 인코딩 → 200 {user, mustChangePassword, csrfToken}, 세션 ID 재발급(고정 방지)', async () => {
    const c = newClient();
    await c.fetchCsrf();
    const before = c.cookie('tf.sid');
    const oldToken = c.csrf;
    const res = await c.login('editor', FIXTURE_PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      user: { loginId: 'editor', userNm: '편집자', isSysAdmin: false },
      mustChangePassword: false,
    });
    expect(typeof (res.body as { csrfToken: string }).csrfToken).toBe('string');
    expect(c.cookie('tf.sid')).toBeDefined();
    expect(c.cookie('tf.sid')).not.toBe(before);
    expect((await c.get('/api/v1/me')).status).toBe(200);
    // 로그인 전 토큰은 새 세션 ID에 바인딩되지 않는다(세션 바인딩 CSRF)
    const fresh = c.csrf;
    c.csrf = oldToken;
    expect((await c.post('/api/v1/auth/logout')).status).toBe(403);
    c.csrf = fresh;
    const last = await t.pool.query(
      "select last_login_at is not null v from tf_user where login_id = 'editor'",
    );
    expect(last.rows[0]).toEqual({ v: true });
  });

  it('실패: 비밀번호 불일치·없는 아이디는 같은 401 본문(계정 존재 비노출)', async () => {
    const a = await newClient().login('editor', 'wrong-pass-1');
    const b = await newClient().login('no-such-user', 'wrong-pass-1');
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body).toMatchObject({
      code: 'E_INVALID_CREDENTIALS',
      type: expect.stringMatching(/unauthorized$/),
    });
    const strip = (x: Record<string, unknown>) => ({ ...x, instance: undefined });
    expect(strip(a.body as Record<string, unknown>)).toEqual(
      strip(b.body as Record<string, unknown>),
    );
  });

  it('연속 5회 실패 → 423 + 남은 시간, 잠금 중에는 맞는 비밀번호도 423, 만료 후 성공하면 카운터 초기화', async () => {
    const c = newClient();
    for (let i = 1; i <= 4; i++)
      expect((await c.login('viewer', `bad-${i}-pass`)).status).toBe(401);
    const fifth = await c.login('viewer', 'bad-5-pass');
    expect(fifth.status).toBe(423);
    expect(fifth.body).toMatchObject({
      code: 'E_LOCKED',
      remainingMinutes: 15,
      type: expect.stringMatching(/locked$/),
    });
    const locked = await c.login('viewer', FIXTURE_PASSWORD);
    expect(locked.status).toBe(423);
    expect((locked.body as { remainingMinutes: number }).remainingMinutes).toBeLessThanOrEqual(15);
    // 잠금 만료(시간 경과를 DB로 재현) → 성공 → 카운터·잠금 초기화
    await t.pool.query(
      "update tf_user set locked_until = CURRENT_TIMESTAMP - interval '1 minute' where login_id = 'viewer'",
    );
    expect((await c.login('viewer', FIXTURE_PASSWORD)).status).toBe(200);
    const r = await t.pool.query(
      "select login_fail_cnt, locked_until from tf_user where login_id = 'viewer'",
    );
    expect(r.rows[0]).toEqual({ login_fail_cnt: 0, locked_until: null });
    const text = allLogText();
    expect(text).toMatch(/계정 잠금: viewer/);
    expect(text).toMatch(/로그인 실패: viewer/);
    expect(text).toMatch(/로그인 성공: viewer/);
    expect(text).not.toContain(FIXTURE_PASSWORD);
    expect(text).not.toContain('bad-5-pass');
  });

  it('비활성 계정은 401(로그인 단계 거부)', async () => {
    await t.pool.query("update tf_user set is_active = false where login_id = 'viewer'");
    try {
      expect((await newClient().login('viewer', FIXTURE_PASSWORD)).status).toBe(401);
    } finally {
      await t.pool.query("update tf_user set is_active = true where login_id = 'viewer'");
    }
  });

  it('로그아웃 → 204, 이후 /me 401', async () => {
    const c = await loggedIn('editor');
    expect((await c.post('/api/v1/auth/logout')).status).toBe(204);
    const me = await c.get('/api/v1/me');
    expect(me.status).toBe(401);
    expect(me.body).toMatchObject({ code: 'E_UNAUTHORIZED' });
  });

  it('서버 재기동(앱 재생성) 후에도 같은 쿠키로 세션 유지(tf_session)', async () => {
    const c = await loggedIn('editor');
    await app.close();
    app = await createTestApp([DummyModule]);
    c.use(server());
    const me = await c.get('/api/v1/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ user: { loginId: 'editor' } });
  });
});

describe('T4.4 가드 4종(더미 컨트롤러)', () => {
  it('SessionAuthGuard: 익명은 401, @Public은 통과', async () => {
    expect((await request(server()).get('/api/v1/dummy/any')).status).toBe(401);
    expect((await request(server()).get('/api/v1/dummy/public')).status).toBe(200);
    expect((await request(server()).get('/health')).status).toBe(200);
  });

  it('SysAdminGuard: 시스템 관리자만, 그 외 403 forbidden', async () => {
    expect((await (await loggedIn('sysadmin')).get('/api/v1/dummy/sys')).status).toBe(200);
    const res = await (await loggedIn('pa')).get('/api/v1/dummy/sys');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'E_FORBIDDEN' });
  });

  it('ProjectRoleGuard: 역할 순서·비멤버 404·템플릿 404(SA 제외)·projectCtx', async () => {
    const viewer = await loggedIn('viewer');
    const r = await viewer.get('/api/v1/projects/PRJA/dummy');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      projectKey: 'PRJA',
      kind: 'PROJECT',
      status: 'ACTIVE',
      role: 'VIEWER',
    });
    expect((await viewer.post('/api/v1/projects/PRJA/dummy')).status).toBe(403);
    expect((await viewer.get('/api/v1/projects/PRJB/dummy')).status).toBe(404); // 비멤버
    expect((await viewer.get('/api/v1/projects/NOPE/dummy')).status).toBe(404);
    expect((await viewer.get('/api/v1/projects/bad-key/dummy')).status).toBe(404);
    const editor = await loggedIn('editor');
    expect((await editor.post('/api/v1/projects/PRJA/dummy')).status).toBe(201);
    expect((await editor.put('/api/v1/projects/PRJA/dummy/settings')).status).toBe(403);
    const pa = await loggedIn('pa');
    expect((await pa.put('/api/v1/projects/PRJA/dummy/settings')).status).toBe(200);
    expect((await pa.get('/api/v1/projects/STDS/dummy')).status).toBe(404); // 템플릿
    const sa = await loggedIn('sysadmin');
    const tpl = await sa.get('/api/v1/projects/STDS/dummy');
    expect(tpl.body).toMatchObject({ kind: 'TEMPLATE', role: 'ADMIN' });
    expect((await sa.put('/api/v1/projects/PRJB/dummy/settings')).body).toMatchObject({
      role: 'ADMIN',
    }); // 멤버십 불필요
  });

  it('ProjectRoleGuard: 보관 프로젝트 쓰기 409 E_PROJECT_READONLY(읽기는 허용)', async () => {
    await t.pool.query("update tf_project set status = 'ARCHIVED' where project_key = 'PRJB'");
    try {
      const pa = await loggedIn('pa');
      expect((await pa.get('/api/v1/projects/PRJB/dummy')).status).toBe(200);
      const w = await pa.put('/api/v1/projects/PRJB/dummy/settings');
      expect(w.status).toBe(409);
      expect(w.body).toMatchObject({ code: 'E_PROJECT_READONLY' });
    } finally {
      await t.pool.query("update tf_project set status = 'ACTIVE' where project_key = 'PRJB'");
    }
  });

  it('PasswordChangeGuard: 강제 변경 중 403 password-change-required, /me·/me/password·/auth/*는 허용', async () => {
    await t.pool.query("update tf_user set pw_change_required = true where login_id = 'editor'");
    try {
      const c = await loggedIn('editor');
      const res = await c.get('/api/v1/dummy/any');
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        code: 'E_PASSWORD_CHANGE_REQUIRED',
        type: expect.stringMatching(/password-change-required$/),
      });
      expect((await c.get('/api/v1/projects/PRJA/dummy')).status).toBe(403);
      const me = await c.get('/api/v1/me');
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({ mustChangePassword: true });
      expect(
        (await c.put('/api/v1/me/password', { currentPassword: 'x', newPassword: 'y' })).status,
      ).toBe(422);
      expect((await c.post('/api/v1/auth/logout')).status).toBe(204);
    } finally {
      await t.pool.query("update tf_user set pw_change_required = false where login_id = 'editor'");
    }
  });

  it('세션이 있어도 계정이 비활성화되면 다음 요청 401(요청마다 DB 재확인)', async () => {
    const c = await loggedIn('viewer');
    await t.pool.query("update tf_user set is_active = false where login_id = 'viewer'");
    try {
      expect((await c.get('/api/v1/me')).status).toBe(401);
    } finally {
      await t.pool.query("update tf_user set is_active = true where login_id = 'viewer'");
    }
  });
});

describe('T4.5 /me·/me/password', () => {
  it('GET /me: 사용자·소속 프로젝트(역할), 시스템 관리자는 전체(템플릿 포함)', async () => {
    const pa = await (await loggedIn('pa')).get('/api/v1/me');
    expect(pa.body).toMatchObject({
      user: { loginId: 'pa', isSysAdmin: false },
      mustChangePassword: false,
      projects: [
        { key: 'PRJA', role: 'ADMIN', kind: 'PROJECT', status: 'ACTIVE' },
        { key: 'PRJB', role: 'ADMIN' },
      ],
    });
    const sa = await (await loggedIn('sysadmin')).get('/api/v1/me');
    const keys = (sa.body as { projects: { key: string; role: string }[] }).projects.map(
      (p) => p.key,
    );
    expect(keys.sort()).toEqual(['PRJA', 'PRJB', 'STDS']);
  });

  it.each([
    ['현재 비밀번호 불일치', 'Wrong-pass9', 'Newpass#2026', 'E_PW_CURRENT_MISMATCH'],
    ['8자 미만', FIXTURE_PASSWORD, 'Ab1!', 'PW_LENGTH'],
    ['64자 초과', FIXTURE_PASSWORD, `Ab1!${'x'.repeat(61)}`, 'PW_LENGTH'],
    ['한 종류만', FIXTURE_PASSWORD, 'abcdefghij', 'PW_CHAR_CLASSES'],
    ['로그인 ID 포함', FIXTURE_PASSWORD, 'Viewer#2026x', 'PW_CONTAINS_LOGIN_ID'],
    ['직전 비밀번호와 동일', FIXTURE_PASSWORD, FIXTURE_PASSWORD, 'PW_SAME_AS_PREVIOUS'],
  ])('422 %s → %s', async (_n, currentPassword, newPassword, code) => {
    const c = await loggedIn('viewer');
    const res = await c.put('/api/v1/me/password', { currentPassword, newPassword });
    if (newPassword.length > 64) {
      expect(res.status).toBe(400); // 스키마 상한(64)
      return;
    }
    expect(res.status).toBe(422);
    expect((res.body as { errors: { code: string }[] }).errors.map((e) => e.code)).toContain(code);
  });

  it('성공 204 → 강제 변경 해제, 다른 세션은 종료, 새 비밀번호로 로그인', async () => {
    await t.pool.query("update tf_user set pw_change_required = true where login_id = 'pa'");
    const other = await loggedIn('pa');
    const c = await loggedIn('pa');
    const res = await c.put('/api/v1/me/password', {
      currentPassword: FIXTURE_PASSWORD,
      newPassword: 'Changed#2026',
    });
    expect(res.status).toBe(204);
    expect((await c.get('/api/v1/me')).body).toMatchObject({ mustChangePassword: false });
    expect((await other.get('/api/v1/me')).status).toBe(401);
    expect((await newClient().login('pa', FIXTURE_PASSWORD)).status).toBe(401);
    expect((await newClient().login('pa', 'Changed#2026')).status).toBe(200);
    // 되돌리기
    await c.put('/api/v1/me/password', {
      currentPassword: 'Changed#2026',
      newPassword: FIXTURE_PASSWORD,
    });
    expect(allLogText()).not.toContain('Changed#2026');
  });
});

describe('T4.6 /admin/users', () => {
  it('목록·검색·상태 필터·건수, 비 시스템 관리자는 403', async () => {
    const sa = await loggedIn('sysadmin');
    const all = await sa.get('/api/v1/admin/users');
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ page: 1, size: 20, counts: { sysAdmin: 1 } });
    const items = (all.body as { items: { loginId: string; projects: unknown[] }[] }).items;
    expect(items.map((u) => u.loginId)).toEqual(
      expect.arrayContaining(['sysadmin', 'pa', 'editor', 'viewer']),
    );
    expect(items.find((u) => u.loginId === 'pa')!.projects).toEqual([
      { key: 'PRJA', nm: '프로젝트 A', role: 'ADMIN' },
      { key: 'PRJB', nm: '프로젝트 B', role: 'ADMIN' },
    ]);
    const q = await sa.get('/api/v1/admin/users?q=%ED%8E%B8%EC%A7%91');
    expect((q.body as { items: { loginId: string }[] }).items.map((u) => u.loginId)).toEqual([
      'editor',
    ]);
    const onlySa = await sa.get('/api/v1/admin/users?sysAdmin=true');
    expect((onlySa.body as { total: number }).total).toBe(1);
    expect((await sa.get('/api/v1/admin/users?status=BOGUS')).status).toBe(400);
    expect((await (await loggedIn('pa')).get('/api/v1/admin/users')).status).toBe(403);
  });

  it('생성: 임시 비밀번호 12자 1회 반환 → 그 비밀번호로 로그인하면 강제 변경, 로그·DB에 평문 없음', async () => {
    const sa = await loggedIn('sysadmin');
    const res = await sa.post('/api/v1/admin/users', {
      loginId: 'newbie',
      userNm: '신규',
      email: 'newbie@example.test',
    });
    expect(res.status).toBe(201);
    expect(res.headers['location']).toMatch(/\/api\/v1\/admin\/users\/\d+$/);
    const body = res.body as {
      user: { id: number; pwChangeRequired: boolean };
      temporaryPassword: string;
    };
    expect(body.temporaryPassword).toHaveLength(12);
    expect(body.user.pwChangeRequired).toBe(true);
    const detail = await sa.get(`/api/v1/admin/users/${body.user.id}`);
    expect(JSON.stringify(detail.body)).not.toContain(body.temporaryPassword);
    const login = await newClient().login('newbie', body.temporaryPassword);
    expect(login.body).toMatchObject({ mustChangePassword: true });
    expect(allLogText()).not.toContain(body.temporaryPassword);
    const leak = await t.pool.query(
      "select count(*)::int n from tf_session where sess::text like '%' || $1 || '%'",
      [body.temporaryPassword],
    );
    expect(leak.rows[0]).toEqual({ n: 0 });
    const dup = await sa.post('/api/v1/admin/users', { loginId: 'newbie', userNm: '중복' });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: 'E_LOGIN_ID_DUP' });
  });

  it('생성: 관리자가 지정한 초기 비밀번호는 정책 검사(422), 응답에 비밀번호 없음', async () => {
    const sa = await loggedIn('sysadmin');
    const bad = await sa.post('/api/v1/admin/users', {
      loginId: 'weak1',
      userNm: '약함',
      initialPassword: 'short',
    });
    expect(bad.status).toBe(422);
    const ok = await sa.post('/api/v1/admin/users', {
      loginId: 'given1',
      userNm: '지정',
      initialPassword: 'Given#2026pw',
    });
    expect(ok.status).toBe(201);
    expect(ok.body).not.toHaveProperty('temporaryPassword');
  });

  it('수정·마지막 시스템 관리자 해제 409·자기 비활성화 409', async () => {
    const sa = await loggedIn('sysadmin');
    const list = await sa.get('/api/v1/admin/users?sysAdmin=true');
    const saId = (list.body as { items: { id: number }[] }).items[0]!.id;
    const demote = await sa.put(`/api/v1/admin/users/${saId}`, {
      userNm: '시스템관리자',
      email: null,
      isSysAdmin: false,
    });
    expect(demote.status).toBe(409);
    expect(demote.body).toMatchObject({ code: 'E_LAST_SYS_ADMIN' });
    const self = await sa.put(`/api/v1/admin/users/${saId}/active`, { isActive: false });
    expect(self.status).toBe(409);
    expect(self.body).toMatchObject({ code: 'E_SELF_DEACTIVATE' });
    const editorId = (await t.pool.query("select user_id from tf_user where login_id = 'editor'"))
      .rows[0].user_id as number;
    const upd = await sa.put(`/api/v1/admin/users/${editorId}`, {
      userNm: '편집자2',
      email: 'e2@example.test',
      isSysAdmin: false,
    });
    expect(upd.body).toMatchObject({ userNm: '편집자2', email: 'e2@example.test' });
    await sa.put(`/api/v1/admin/users/${editorId}`, {
      userNm: '편집자',
      email: 'editor@example.test',
      isSysAdmin: false,
    });
    expect((await sa.get('/api/v1/admin/users/999999')).status).toBe(404);
  });

  it('비활성화 → 그 사용자 세션 종료(401)·로그인 거부, 활성화 → 복귀', async () => {
    const sa = await loggedIn('sysadmin');
    const viewer = await loggedIn('viewer');
    const id = (await t.pool.query("select user_id from tf_user where login_id = 'viewer'")).rows[0]
      .user_id as number;
    expect(
      (await sa.put(`/api/v1/admin/users/${id}/active`, { isActive: false })).body,
    ).toMatchObject({ isActive: false });
    expect((await viewer.get('/api/v1/me')).status).toBe(401);
    expect((await newClient().login('viewer', FIXTURE_PASSWORD)).status).toBe(401);
    expect(
      (await sa.put(`/api/v1/admin/users/${id}/active`, { isActive: true })).body,
    ).toMatchObject({ isActive: true });
    expect((await newClient().login('viewer', FIXTURE_PASSWORD)).status).toBe(200);
  });

  it('비밀번호 초기화: 12자 1회, 이전 비밀번호 무효·잠금 해제·강제 변경·기존 세션 종료 / 잠금 해제', async () => {
    const sa = await loggedIn('sysadmin');
    const target = await loggedIn('editor');
    const id = (await t.pool.query("select user_id from tf_user where login_id = 'editor'")).rows[0]
      .user_id as number;
    await t.pool.query(
      "update tf_user set locked_until = CURRENT_TIMESTAMP + interval '10 minute' where user_id = $1",
      [id],
    );
    const lockedList = await sa.get('/api/v1/admin/users?status=LOCKED');
    expect((lockedList.body as { items: { loginId: string; locked: boolean }[] }).items).toEqual([
      expect.objectContaining({ loginId: 'editor', locked: true }),
    ]);
    const un = await sa.post(`/api/v1/admin/users/${id}/unlock`);
    expect(un.body).toMatchObject({ locked: false });
    const res = await sa.post(`/api/v1/admin/users/${id}/reset-password`);
    expect(res.status).toBe(200);
    const temp = (res.body as { temporaryPassword: string }).temporaryPassword;
    expect(temp).toHaveLength(12);
    expect((await target.get('/api/v1/me')).status).toBe(401);
    expect((await newClient().login('editor', FIXTURE_PASSWORD)).status).toBe(401);
    const c = newClient();
    expect((await c.login('editor', temp)).body).toMatchObject({ mustChangePassword: true });
    expect(
      (await c.put('/api/v1/me/password', { currentPassword: temp, newPassword: FIXTURE_PASSWORD }))
        .status,
    ).toBe(204);
    expect(allLogText()).not.toContain(temp);
  });
});
