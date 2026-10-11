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
  // 단계 8 행: 기존 테이블의 이력 v1 + FINAL 테이블 1개(확정 해제·FINAL 삭제 = 프로젝트 관리자)
  const tableId = await one(`select table_id id from prj_table where project_id = ${PRJA}`);
  await t.pool.query(
    `insert into prj_table_history (table_id, version, action, change_summary, snapshot, saved_by)
     values ($1, 1, 'CREATE', '테이블 생성', $2::jsonb, 'editor')`,
    [
      tableId,
      JSON.stringify({
        schemaVersion: 1,
        table: {
          tableId,
          bizAreaId: bizId('RP'),
          tableNm: 'RP_RSCH_PRJ_MAST',
          tableLogicalNm: '연구과제마스터',
        },
        columns: [],
        action: 'CREATE',
      }),
    ],
  );
  const finalTableId = await one(
    `insert into prj_table (project_id, biz_area_id, table_nm, table_logical_nm, status, finalized_at, finalized_by, created_by, updated_by)
     values (${PRJA}, ${bizId('RP')}, 'RP_FINAL_MST', '확정 테이블', 'FINAL', now(), 'editor', 'editor', 'editor') returning table_id id`,
  );
  let n = 0;
  ctx = {
    targetUserId: rows[0].user_id as number,
    seq: () => ++n,
    fixturePassword: FIXTURE_PASSWORD,
    bizRpId: bizId('RP'),
    bizPsId: bizId('PS'),
    paUserId: pa.rows[0].user_id as number,
    tableId,
    finalTableId,
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

/**
 * T10.1 매트릭스 완전성(CR-01-4): Nest 메타데이터(컨트롤러 경로 + 핸들러 경로·메서드)로 서버 라우트 전부를 모아
 * 매트릭스 행(`METHOD path`)과 대조한다. 라우트가 추가됐는데 행이 없으면 실패한다. 경로 변수 이름은 무시(`:id` = `{id}`),
 * 매트릭스 경로의 괄호 주석(`(→FINAL)` 등)은 같은 라우트의 다른 경우로 보고 지운다.
 */
describe('권한 매트릭스 완전성(T10.1)', () => {
  /** 매트릭스 밖 라우트와 사유(§7.3 표 밖: 익명 공개 운영 엔드포인트). */
  const EXEMPT: Record<string, string> = {
    'GET /health': '헬스(§12.3, 익명·사내 모니터링 폴링) — test:db health',
    'GET /metrics': '지표(§12.3, 익명·로컬, CR-08 C6) — test:db autocomplete /metrics',
    'POST /mcp': '외부 연동(CR-18, 접근 토큰 전용·도구별 권한은 REST 행 그대로) — test:db mcp',
    'GET /mcp': '외부 연동(CR-18) 무상태 405 — test:db mcp',
    'DELETE /mcp': '외부 연동(CR-18) 무상태 405 — test:db mcp',
  };
  const norm = (p: string) =>
    `/${p}`
      .replace(/\([^)]*\)/g, '')
      .replace(/\/+/g, '/')
      .replace(/\/$/, '')
      .replace(/:[A-Za-z]+/g, '{}')
      .replace(/\{[^}]*\}/g, '{}');

  it('서버 라우트 전부가 매트릭스 행 또는 예외 목록에 있다(누락 0), 매트릭스에 없는 라우트 행도 0', async () => {
    const { ModulesContainer } = await import('@nestjs/core');
    const { METHOD_METADATA, PATH_METADATA } = await import('@nestjs/common/constants.js');
    const { RequestMethod } = await import('@nestjs/common');
    const routes = new Set<string>();
    for (const mod of app.get(ModulesContainer).values()) {
      for (const wrapper of mod.controllers.values()) {
        const ctrl = wrapper.metatype as (new (...a: unknown[]) => unknown) | null;
        if (!ctrl) continue;
        const base = ([] as string[]).concat(Reflect.getMetadata(PATH_METADATA, ctrl) ?? '')[0]!;
        const proto = ctrl.prototype as Record<string, unknown>;
        for (const name of Object.getOwnPropertyNames(proto)) {
          const fn = proto[name];
          if (name === 'constructor' || typeof fn !== 'function') continue;
          const sub = Reflect.getMetadata(PATH_METADATA, fn) as string | string[] | undefined;
          const method = Reflect.getMetadata(METHOD_METADATA, fn) as number | undefined;
          if (sub === undefined || method === undefined) continue;
          // 전역 접두어 /api/v1은 매트릭스 표기에서도 생략한다(/health·/metrics는 접두어 밖)
          for (const s of ([] as string[]).concat(sub)) {
            routes.add(`${RequestMethod[method]} ${norm(`${base}/${s}`)}`);
          }
        }
      }
    }
    const rows = new Set(
      AUTHZ_MATRIX.map((r) => {
        const p = r.path.startsWith('P') ? `/projects/{key}${r.path.slice(1)}` : r.path;
        return `${r.method} ${norm(p)}`;
      }),
    );
    const exempt = new Set(
      Object.keys(EXEMPT).map((k) => k.replace(/ (.*)$/, (_m, p) => ` ${norm(p)}`)),
    );
    const missing = [...routes].filter((r) => !rows.has(r) && !exempt.has(r)).sort();
    const stale = [...rows].filter((r) => !routes.has(r)).sort();
    process.stderr.write(
      `[authz-matrix] 라우트 ${routes.size}(예외 ${exempt.size}) · 매트릭스 고유 행 ${rows.size}(전체 ${AUTHZ_MATRIX.length}) · 누락 ${missing.length} · 없는 라우트 행 ${stale.length}\n`,
    );
    expect(missing, '매트릭스에 없는 라우트').toEqual([]);
    expect(stale, '서버에 없는 매트릭스 행').toEqual([]);
    expect(routes.size).toBeGreaterThanOrEqual(90);
  });

  it('비멤버 404 · 마지막 프로젝트 관리자 제거 409 행이 매트릭스에 있다(CR-01-4)', () => {
    const projectRows = AUTHZ_MATRIX.filter((r) => r.path.startsWith('P'));
    // 프로젝트 자원 행은 모두 비멤버(login)를 404로 판정한다(허용 역할에 login이 없는 한)
    const notFound = projectRows.filter(
      (r) => r.allow.includes('login') || r.denyByRole?.login === 404,
    );
    expect(notFound).toHaveLength(projectRows.length);
    const lastPa = AUTHZ_MATRIX.filter(
      (r) => r.path === 'P/members/{userId}' && r.ok.includes(409),
    );
    expect(lastPa.length).toBeGreaterThanOrEqual(1);
  });
});
