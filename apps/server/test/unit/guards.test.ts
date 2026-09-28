import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { ALLOW_PW_CHANGE, IS_PUBLIC, PROJECT_ROLE } from '../../src/auth/decorators.js';
import { PasswordChangeGuard } from '../../src/auth/guards/password-change.guard.js';
import { ProjectRoleGuard } from '../../src/auth/guards/project-role.guard.js';
import { SessionAuthGuard } from '../../src/auth/guards/session-auth.guard.js';
import { SysAdminGuard } from '../../src/auth/guards/sys-admin.guard.js';
import type { AuthUser } from '../../src/auth/session-user.js';
import { ProblemException } from '../../src/common/problem/problem.exception.js';
import type { Db } from '../../src/db/client.js';

// T4.4 가드별 단위 테스트(가짜 ExecutionContext·가짜 DB). 실 DB 통합은 test/db/auth.test.ts
const user = (over: Partial<AuthUser> = {}): AuthUser => ({
  id: 1,
  loginId: 'u1',
  userNm: '사용자',
  isSysAdmin: false,
  mustChangePassword: false,
  ...over,
});

function ctx(req: Record<string, unknown>, meta: Record<string, unknown> = {}): ExecutionContext {
  const handler = () => undefined;
  Reflect.defineMetadata(IS_PUBLIC, meta[IS_PUBLIC], handler);
  for (const [k, v] of Object.entries(meta)) Reflect.defineMetadata(k, v, handler);
  return {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

/** select().from().leftJoin?().where() 체인이 rows를 돌려주는 가짜 Drizzle. */
function fakeDb(rows: unknown[]): Db {
  const chain = {
    from: () => chain,
    leftJoin: () => chain,
    where: () => Promise.resolve(rows),
  };
  return { select: () => chain } as unknown as Db;
}

async function problemOf(
  p: Promise<unknown> | (() => unknown),
): Promise<{ status: number; code: string }> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    if (e instanceof ProblemException) return { status: e.getStatus(), code: e.code };
    throw e;
  }
  throw new Error('예외가 없음');
}

describe('SessionAuthGuard', () => {
  it('@Public은 세션 없이 통과, 그 외 세션 없으면 401', async () => {
    const g = new SessionAuthGuard(new Reflector(), fakeDb([]));
    await expect(g.canActivate(ctx({}, { [IS_PUBLIC]: true }))).resolves.toBe(true);
    expect(await problemOf(g.canActivate(ctx({ session: {} })))).toEqual({
      status: 401,
      code: 'E_UNAUTHORIZED',
    });
  });
  it('세션 사용자를 DB 최신 값으로 채우고, 비활성이면 세션 삭제 + 401', async () => {
    const req: Record<string, unknown> = { session: { user: { id: 1, loginId: 'u1' } } };
    const g = new SessionAuthGuard(
      new Reflector(),
      fakeDb([
        {
          id: 1,
          loginId: 'u1',
          userNm: '새이름',
          isSysAdmin: true,
          isActive: true,
          pwChangeRequired: true,
        },
      ]),
    );
    await expect(g.canActivate(ctx(req))).resolves.toBe(true);
    expect(req['authUser']).toEqual({
      id: 1,
      loginId: 'u1',
      userNm: '새이름',
      isSysAdmin: true,
      mustChangePassword: true,
    });
    let destroyed = false;
    const req2 = {
      session: {
        user: { id: 1, loginId: 'u1' },
        destroy: (cb: () => void) => ((destroyed = true), cb()),
      },
    };
    const g2 = new SessionAuthGuard(
      new Reflector(),
      fakeDb([{ id: 1, loginId: 'u1', isActive: false }]),
    );
    expect(await problemOf(g2.canActivate(ctx(req2)))).toMatchObject({ status: 401 });
    expect(destroyed).toBe(true);
  });
});

describe('PasswordChangeGuard', () => {
  const g = new PasswordChangeGuard(new Reflector());
  it('강제 변경이 아니면 통과, 강제 변경이면 403 password-change-required', async () => {
    expect(g.canActivate(ctx({ authUser: user() }))).toBe(true);
    expect(g.canActivate(ctx({}))).toBe(true); // 공개 경로
    expect(
      await problemOf(() => g.canActivate(ctx({ authUser: user({ mustChangePassword: true }) }))),
    ).toEqual({
      status: 403,
      code: 'E_PASSWORD_CHANGE_REQUIRED',
    });
  });
  it('@AllowDuringPasswordChange는 통과', () => {
    expect(
      g.canActivate(
        ctx({ authUser: user({ mustChangePassword: true }) }, { [ALLOW_PW_CHANGE]: true }),
      ),
    ).toBe(true);
  });
});

describe('SysAdminGuard', () => {
  const g = new SysAdminGuard();
  it('시스템 관리자 통과, 그 외 403, 미인증 401', async () => {
    expect(g.canActivate(ctx({ authUser: user({ isSysAdmin: true }) }))).toBe(true);
    expect(await problemOf(() => g.canActivate(ctx({ authUser: user() })))).toEqual({
      status: 403,
      code: 'E_FORBIDDEN',
    });
    expect(await problemOf(() => g.canActivate(ctx({})))).toMatchObject({ status: 401 });
  });
});

describe('ProjectRoleGuard', () => {
  const run = (rows: unknown[], req: Record<string, unknown>, role: string) =>
    new ProjectRoleGuard(new Reflector(), fakeDb(rows)).canActivate(
      ctx(req, { [PROJECT_ROLE]: role }),
    );
  const proj = (over: Record<string, unknown> = {}) => ({
    projectId: 7,
    kind: 'PROJECT',
    status: 'ACTIVE',
    memberRole: 'EDITOR',
    ...over,
  });
  const req = (over: Record<string, unknown> = {}) => ({
    method: 'GET',
    params: { projectKey: 'PRJA' },
    authUser: user(),
    ...over,
  });

  it('멤버 역할 이상이면 통과 + projectCtx', async () => {
    const r = req();
    await expect(run([proj()], r, 'VIEWER')).resolves.toBe(true);
    expect(r['projectCtx']).toEqual({
      projectId: 7,
      projectKey: 'PRJA',
      kind: 'PROJECT',
      status: 'ACTIVE',
      role: 'EDITOR',
    });
  });
  it('역할 부족 403, 비멤버·없는 키·형식 오류·템플릿 404', async () => {
    expect(await problemOf(run([proj()], req(), 'ADMIN'))).toMatchObject({ status: 403 });
    expect(await problemOf(run([proj({ memberRole: null })], req(), 'VIEWER'))).toMatchObject({
      status: 404,
    });
    expect(await problemOf(run([], req(), 'VIEWER'))).toMatchObject({ status: 404 });
    expect(
      await problemOf(run([proj()], req({ params: { projectKey: 'x;drop' } }), 'VIEWER')),
    ).toMatchObject({ status: 404 });
    expect(await problemOf(run([proj({ kind: 'TEMPLATE' })], req(), 'VIEWER'))).toMatchObject({
      status: 404,
    });
  });
  it('시스템 관리자는 멤버십 없이 ADMIN, 템플릿 쓰기 허용', async () => {
    const r = req({ method: 'PUT', authUser: user({ isSysAdmin: true }) });
    await expect(run([proj({ kind: 'TEMPLATE', memberRole: null })], r, 'ADMIN')).resolves.toBe(
      true,
    );
    expect(r['projectCtx']).toMatchObject({ role: 'ADMIN', kind: 'TEMPLATE' });
  });
  it('보관 프로젝트 쓰기 409 E_PROJECT_READONLY, 읽기는 통과', async () => {
    expect(
      await problemOf(run([proj({ status: 'ARCHIVED' })], req({ method: 'POST' }), 'EDITOR')),
    ).toEqual({
      status: 409,
      code: 'E_PROJECT_READONLY',
    });
    await expect(run([proj({ status: 'ARCHIVED' })], req(), 'VIEWER')).resolves.toBe(true);
  });
});
