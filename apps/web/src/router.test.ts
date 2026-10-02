import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryHistory, type RouteLocationNormalized } from 'vue-router';
import { createApiClient } from './api/client.js';
import { installAuth } from './auth-wiring.js';
import { authGuard, createAppRouter, safeNext, type GuardSession } from './router.js';
import { useSessionStore } from './stores/session.js';
import { fakeFetch, json, problem } from './test-utils.js';

// T4.10 라우트 가드(401 → /login?next=, 강제 변경 → /me?forcePassword=1) · 세션 만료 후 원래 경로 복귀
const me = (over: Record<string, unknown> = {}) => ({
  user: { id: 1, loginId: 'kim', userNm: '김', isSysAdmin: false },
  mustChangePassword: false,
  projects: [],
  ...over,
});

describe('authGuard', () => {
  const session = (s: Partial<GuardSession>): GuardSession => ({
    ensureLoaded: () => Promise.resolve(),
    isLoggedIn: false,
    mustChangePassword: false,
    isSysAdmin: false,
    ...s,
  });
  const router = createAppRouter(createMemoryHistory());
  const to = (path: string) => router.resolve(path) as unknown as RouteLocationNormalized;

  it('비로그인 → /login?next=원래경로, 로그인 화면은 통과', async () => {
    expect(await authGuard(to('/admin/users?q=1'), session({}))).toEqual({
      path: '/login',
      query: { next: '/admin/users?q=1' },
    });
    expect(await authGuard(to('/login'), session({}))).toBe(true);
  });
  it('강제 변경 중에는 /me?forcePassword=1로 고정', async () => {
    const s = session({ isLoggedIn: true, mustChangePassword: true });
    expect(await authGuard(to('/projects'), s)).toEqual({
      path: '/me',
      query: { forcePassword: '1' },
    });
    expect(await authGuard(to('/me'), s)).toEqual({ path: '/me', query: { forcePassword: '1' } });
    expect(await authGuard(to('/me?forcePassword=1'), s)).toBe(true);
    expect(await authGuard(to('/login'), s)).toEqual({
      path: '/me',
      query: { forcePassword: '1' },
    });
  });
  it('시스템 관리자 화면: 일반 사용자 /forbidden, 로그인 상태에서 /login은 next로', async () => {
    expect(await authGuard(to('/admin/users'), session({ isLoggedIn: true }))).toEqual({
      path: '/forbidden',
    });
    expect(
      await authGuard(to('/admin/users'), session({ isLoggedIn: true, isSysAdmin: true })),
    ).toBe(true);
    expect(await authGuard(to('/login?next=/me'), session({ isLoggedIn: true }))).toBe('/me');
  });
  it('safeNext: 앱 내부 경로만(오픈 리다이렉트 방지)', () => {
    expect(safeNext('/admin/users')).toBe('/admin/users');
    expect(safeNext('//evil.example')).toBe('/projects');
    expect(safeNext('https://evil.example')).toBe('/projects');
    expect(safeNext(undefined)).toBe('/projects');
  });
});

describe('세션 만료 → 로그인 → 원래 경로 복귀(installAuth)', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('로그인 상태에서 API 401 → /login?next=현재경로 → 로그인 후 그 경로로', async () => {
    let loggedIn = true;
    const f = fakeFetch({
      'GET /api/v1/auth/csrf': () => json(200, { token: 'T' }),
      'GET /api/v1/me': () =>
        loggedIn
          ? json(200, me({ user: { id: 1, loginId: 'sa', userNm: '관리', isSysAdmin: true } }))
          : problem(401, 'unauthorized', 'E_UNAUTHORIZED'),
      'GET /api/v1/admin/users': () => problem(401, 'unauthorized', 'E_UNAUTHORIZED'),
      'POST /api/v1/auth/login': () => {
        loggedIn = true;
        return json(200, {
          user: { id: 1, loginId: 'sa', userNm: '관리', isSysAdmin: true },
          mustChangePassword: false,
          csrfToken: 'T2',
        });
      },
    });
    const client = createApiClient({ fetch: f.fetch });
    const session = useSessionStore();
    session.useClient(client);
    const router = createAppRouter(createMemoryHistory());
    installAuth(router, session, client);

    await router.push('/admin/users');
    expect(router.currentRoute.value.fullPath).toBe('/admin/users');
    // 세션 만료: 다음 API가 401. 폴링(waitFor 제한 시간) 대신 로그인 화면 이동 완료 이벤트를 기다린다(CR-05 C1).
    const toLogin = new Promise<void>((resolve) => {
      const off = router.afterEach((to) => {
        if (to.path === '/login') {
          off();
          resolve();
        }
      });
    });
    loggedIn = false;
    await client.get('/admin/users').catch(() => undefined);
    await toLogin;
    expect(router.currentRoute.value.path).toBe('/login');
    expect(router.currentRoute.value.query['next']).toBe('/admin/users');
    expect(session.isLoggedIn).toBe(false);

    await session.login('sa', 'pw');
    await router.replace(safeNext(router.currentRoute.value.query['next']));
    expect(router.currentRoute.value.fullPath).toBe('/admin/users');
  });
});
