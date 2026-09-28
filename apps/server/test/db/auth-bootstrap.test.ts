import { Logger, type INestApplication } from '@nestjs/common';
import bcrypt from 'bcrypt';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BOOTSTRAP_ADMIN_NM, ensureInitialAdmin } from '../../src/auth/bootstrap-admin.js';
import { createDb } from '../../src/db/client.js';
import { parseEnv } from '../../src/config/env.schema.js';
import { Client, createTestApp, setTestEnv, TEST_ADMIN_PASSWORD } from './setup/app.js';
import { createMigratedDatabase } from './setup/databases.js';

// T4.3 초기 관리자 부트스트랩 + 게이트 4 시나리오(API 수준):
// admin 로그인 → 비밀번호 강제 변경 → 사용자 editor1 생성 → 로그아웃 → editor1 로그인(강제 변경)
let app: INestApplication;
let pool: pg.Pool;
const logged: string[] = [];

beforeAll(async () => {
  const url = await createMigratedDatabase('t_auth_boot');
  pool = new pg.Pool({ connectionString: url, max: 2 });
  vi.spyOn(Logger.prototype, 'log').mockImplementation(function (this: Logger, ...a: unknown[]) {
    logged.push(a.map(String).join(' '));
  });
  setTestEnv(url);
  app = await createTestApp();
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('T4.3 부트스트랩', () => {
  it('tf_user 0건 → 시스템 관리자 1명(강제 변경, created_by SYSTEM, 멤버십 없음), 로그에 비밀번호 없음', async () => {
    const { rows } = await pool.query(
      'select login_id, user_nm, is_sys_admin, pw_change_required, created_by, password_hash from tf_user',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      login_id: 'admin',
      user_nm: BOOTSTRAP_ADMIN_NM,
      is_sys_admin: true,
      pw_change_required: true,
      created_by: 'SYSTEM',
    });
    expect(await bcrypt.compare(TEST_ADMIN_PASSWORD, rows[0].password_hash as string)).toBe(true);
    const m = await pool.query('select count(*)::int n from tf_project_member');
    expect(m.rows[0]).toEqual({ n: 0 });
    expect(logged.filter((l) => l.includes('초기 관리자 생성: admin'))).toHaveLength(1);
    expect(logged.join('\n')).not.toContain(TEST_ADMIN_PASSWORD);
  });

  it('이미 사용자가 있으면 만들지 않는다(재기동·동시 기동)', async () => {
    const db = createDb(pool);
    const env = { TERMFLOW_ADMIN_LOGIN: 'admin2', TERMFLOW_ADMIN_PASSWORD: 'Another#2026' };
    expect(await ensureInitialAdmin(db, env, () => {})).toBe(false);
    const { rows } = await pool.query('select count(*)::int n from tf_user');
    expect(rows[0]).toEqual({ n: 1 });
  });

  it('prod: TERMFLOW_ADMIN_PASSWORD 없으면 환경 변수 검증 실패(기동 실패), dev는 개발용 기본값', () => {
    const base = {
      TERMFLOW_DB_URL: 'postgres://h:5432/d',
      TERMFLOW_DB_PASSWORD: 'x',
      TERMFLOW_SESSION_SECRET: 's'.repeat(40),
    };
    const prod = parseEnv({ ...base, NODE_ENV: 'production' });
    expect(prod.ok).toBe(false);
    expect(prod.ok ? [] : prod.missing).toContain('TERMFLOW_ADMIN_PASSWORD');
    const dev = parseEnv({ ...base, NODE_ENV: 'development' });
    expect(dev.ok && dev.env.usedDevDefaults).toEqual(['TERMFLOW_ADMIN_PASSWORD']);
  });
});

describe('게이트 4 시나리오(API)', () => {
  it('admin 로그인 → 강제 변경 → editor1 생성 → 로그아웃 → editor1 로그인(강제 변경) → 변경 후 사용', async () => {
    const admin = new Client(app.getHttpServer());
    const login = await admin.login('admin', TEST_ADMIN_PASSWORD);
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({
      user: { loginId: 'admin', isSysAdmin: true },
      mustChangePassword: true,
    });
    // 강제 변경 전에는 사용자 API 403
    expect((await admin.get('/api/v1/admin/users')).status).toBe(403);
    expect(
      (
        await admin.put('/api/v1/me/password', {
          currentPassword: TEST_ADMIN_PASSWORD,
          newPassword: 'Boot#Changed26',
        })
      ).status,
    ).toBe(204);
    expect((await admin.get('/api/v1/me')).body).toMatchObject({ mustChangePassword: false });

    const created = await admin.post('/api/v1/admin/users', {
      loginId: 'editor1',
      userNm: '편집자1',
      email: null,
      isSysAdmin: false,
    });
    expect(created.status).toBe(201);
    const temp = (created.body as { temporaryPassword: string }).temporaryPassword;
    expect(temp).toHaveLength(12);
    expect((await admin.post('/api/v1/auth/logout')).status).toBe(204);
    expect((await admin.get('/api/v1/me')).status).toBe(401);

    const editor = new Client(app.getHttpServer());
    const el = await editor.login('editor1', temp);
    expect(el.body).toMatchObject({
      user: { loginId: 'editor1', isSysAdmin: false },
      mustChangePassword: true,
    });
    expect((await editor.get('/api/v1/admin/users')).status).toBe(403);
    expect(
      (
        await editor.put('/api/v1/me/password', {
          currentPassword: temp,
          newPassword: 'Design#2026ok',
        })
      ).status,
    ).toBe(204);
    const me = await editor.get('/api/v1/me');
    expect(me.body).toMatchObject({
      user: { loginId: 'editor1' },
      mustChangePassword: false,
      projects: [],
    });
    // 시스템 관리자가 아니므로 사용자 관리는 403(강제 변경과 무관한 권한 거부)
    const denied = await editor.get('/api/v1/admin/users');
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: 'E_FORBIDDEN' });
  });
});
