import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTHZ_MATRIX, ROLE_LOGIN, ROLES, type MatrixCtx, type Role } from '../api/authz-matrix.js';
import { Client, createTestApp, setTestEnv } from './setup/app.js';
import { FIXTURE_PASSWORD, useTestDb } from './setup/databases.js';

// T4.7 권한 매트릭스: §7.3 표(test/api/authz-matrix.ts) × 역할 6종 자동 생성
const t = useTestDb('t_authz', { fixture: 'std_small' });
let app: INestApplication;
let ctx: MatrixCtx;

beforeAll(async () => {
  // 무소속 로그인 사용자·사용자 관리 대상(비밀번호는 픽스처와 같은 해시)
  await t.pool
    .query(`insert into tf_user (login_id, user_nm, password_hash, pw_change_required, created_by, updated_by)
    select v.login_id, v.nm, u.password_hash, false, 'SYSTEM', 'SYSTEM'
      from (values ('nobody', '무소속'), ('target1', '대상')) v(login_id, nm)
      cross join (select password_hash from tf_user where login_id = 'viewer') u`);
  const { rows } = await t.pool.query("select user_id from tf_user where login_id = 'target1'");
  let n = 0;
  ctx = {
    targetUserId: rows[0].user_id as number,
    seq: () => ++n,
    fixturePassword: FIXTURE_PASSWORD,
  };
  setTestEnv(t.url);
  app = await createTestApp();
});
afterAll(async () => {
  await app?.close();
});

async function clientFor(role: Role): Promise<Client> {
  const c = new Client(app.getHttpServer());
  await c.fetchCsrf();
  if (role !== 'anon') {
    const res = await c.login(ROLE_LOGIN[role], FIXTURE_PASSWORD);
    expect(res.status, `${role} 로그인`).toBe(200);
  }
  return c;
}

describe('권한 매트릭스(§7.3)', () => {
  const cases = AUTHZ_MATRIX.flatMap((row) => ROLES.map((role) => ({ row, role })));

  it('행 수·역할 수(보고용 커버리지)', () => {
    console.log(
      `[authz-matrix] 행 ${AUTHZ_MATRIX.length} × 역할 ${ROLES.length} = ${cases.length}건`,
    );
    expect(AUTHZ_MATRIX.length).toBeGreaterThanOrEqual(12);
  });

  it.each(cases.map((c) => [`${c.row.method} ${c.row.path}`, c.role, c] as const))(
    '%s — %s',
    async (_name, role, { row }) => {
      const c = await clientFor(role);
      const res = await row.run(c, ctx);
      if (row.allow.includes(role)) {
        expect(row.ok, `허용인데 ${res.status}: ${JSON.stringify(res.body)}`).toContain(res.status);
      } else {
        const expected = role === 'anon' ? 401 : (row.deny ?? 403);
        expect(res.status, JSON.stringify(res.body)).toBe(expected);
      }
    },
  );
});
