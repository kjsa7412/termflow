import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTHZ_MATRIX, ROLE_LOGIN, ROLES, type MatrixCtx, type Role } from '../api/authz-matrix.js';
import { Client, createTestApp, setTestEnv } from './setup/app.js';
import { FIXTURE_PASSWORD, useTestDb } from './setup/databases.js';

// T4.7·T5.14 권한 매트릭스: §7.3 표(test/api/authz-matrix.ts) × 역할 6종 자동 생성
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
  const pa = await t.pool.query("select user_id from tf_user where login_id = 'pa'");
  const biz = await t.pool.query(
    "select b.biz_cd, b.biz_area_id from prj_biz_area b join tf_project p using (project_id) where p.project_key = 'PRJA'",
  );
  const bizId = (cd: string) => biz.rows.find((r) => r.biz_cd === cd)!.biz_area_id as number;
  const one = async (q: string) => (await t.pool.query(q)).rows[0].id as number;
  const PRJA = "(select project_id from tf_project where project_key = 'PRJA')";
  const std = {
    termId: await one(
      `select term_id id from std_term where project_id = ${PRJA} and term_kor = '용어2'`,
    ),
    pendingApproveId: await one(
      `select term_id id from std_term where project_id = ${PRJA} and term_kor = '용어49'`,
    ),
    pendingRejectId: await one(
      `select term_id id from std_term where project_id = ${PRJA} and term_kor = '용어50'`,
    ),
    domainId: await one(`select max(domain_id) id from std_domain where project_id = ${PRJA}`),
    domainClsId: await one(
      `select domain_cls_id id from std_domain_cls where project_id = ${PRJA} and suffix = 'SFX01'`,
    ),
    codeClsId: await one(
      `select code_cls_id id from std_code_cls where project_id = ${PRJA} and code_cls = 'RP001'`,
    ),
    setId: await one(`select set_id id from std_default_col_set where project_id = ${PRJA}`),
  };
  let n = 0;
  ctx = {
    targetUserId: rows[0].user_id as number,
    seq: () => ++n,
    fixturePassword: FIXTURE_PASSWORD,
    bizRpId: bizId('RP'),
    bizPsId: bizId('PS'),
    paUserId: pa.rows[0].user_id as number,
    tableId: await one(`select table_id id from prj_table where project_id = ${PRJA}`),
    std,
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
    expect(AUTHZ_MATRIX.length).toBeGreaterThanOrEqual(90);
  });

  it.each(cases.map((c) => [`${c.row.method} ${c.row.path}`, c.role, c] as const))(
    '%s — %s',
    async (_name, role, { row }) => {
      const c = await clientFor(role);
      const res = await row.run(c, ctx);
      if (row.allow.includes(role)) {
        expect(row.ok, `허용인데 ${res.status}: ${JSON.stringify(res.body)}`).toContain(res.status);
      } else {
        const expected = role === 'anon' ? 401 : (row.denyByRole?.[role] ?? row.deny ?? 403);
        expect(res.status, JSON.stringify(res.body)).toBe(expected);
      }
    },
  );
});
