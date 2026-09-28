import {
  createRouter,
  createWebHistory,
  type RouteLocationNormalized,
  type RouteLocationRaw,
  type RouteRecordRaw,
  type RouterHistory,
} from 'vue-router';

/**
 * 라우터(§10.1, history 모드, T4.10). 라우트 가드:
 *  - 비로그인 → `/login?next=원래경로`(로그인 후 복귀)
 *  - 강제 비밀번호 변경 중 → `/me?forcePassword=1`로 고정(§7.6)
 *  - `meta.sysAdmin` → 시스템 관리자 외 `/forbidden`
 * `meta.public`(로그인)·`meta.layout`('auth' = 가운데 카드 레이아웃).
 */
declare module 'vue-router' {
  interface RouteMeta {
    public?: boolean;
    sysAdmin?: boolean;
    layout?: 'app' | 'auth';
    rail?: boolean;
    title?: string;
  }
}

export const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/projects' },
  {
    path: '/login',
    name: 'login',
    component: () => import('./pages/LoginPage.vue'),
    meta: { public: true, layout: 'auth', title: '로그인' },
  },
  {
    path: '/projects',
    name: 'projects',
    component: () => import('./pages/ProjectsPage.vue'),
    meta: { title: '프로젝트' },
  },
  {
    path: '/projects/:projectKey',
    name: 'project-home',
    component: () => import('./pages/ProjectHomePage.vue'),
    meta: { title: '프로젝트 홈' },
  },
  {
    path: '/me',
    name: 'me',
    component: () => import('./pages/MePage.vue'),
    meta: { title: '내 계정' },
  },
  {
    path: '/admin/users',
    name: 'admin-users',
    component: () => import('./pages/AdminUsersPage.vue'),
    meta: { sysAdmin: true, title: '사용자' },
  },
  {
    path: '/forbidden',
    name: 'forbidden',
    component: () => import('./pages/ForbiddenPage.vue'),
    meta: { title: '권한 없음' },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('./pages/NotFoundPage.vue'),
    meta: { title: '찾을 수 없음' },
  },
];

export interface GuardSession {
  ensureLoaded(): Promise<void>;
  readonly isLoggedIn: boolean;
  readonly mustChangePassword: boolean;
  readonly isSysAdmin: boolean;
}

/** `next`는 같은 앱 안의 경로만 허용(오픈 리다이렉트 방지). */
export function safeNext(next: unknown): string {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')
    ? next
    : '/projects';
}

export async function authGuard(
  to: RouteLocationNormalized,
  session: GuardSession,
): Promise<true | RouteLocationRaw> {
  await session.ensureLoaded();
  if (to.meta.public) {
    if (to.name === 'login' && session.isLoggedIn) {
      return session.mustChangePassword
        ? { path: '/me', query: { forcePassword: '1' } }
        : safeNext(to.query['next']);
    }
    return true;
  }
  if (!session.isLoggedIn) return { path: '/login', query: { next: to.fullPath } };
  if (session.mustChangePassword) {
    if (to.path === '/me' && to.query['forcePassword'] === '1') return true;
    return { path: '/me', query: { forcePassword: '1' } };
  }
  if (to.meta.sysAdmin && !session.isSysAdmin) return { path: '/forbidden' };
  return true;
}

export function createAppRouter(history: RouterHistory = createWebHistory()) {
  return createRouter({ history, routes });
}
