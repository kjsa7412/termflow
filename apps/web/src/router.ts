import {
  createMemoryHistory,
  createRouter,
  createWebHistory,
  type RouteLocationNormalized,
  type RouteLocationRaw,
  type RouteRecordRaw,
  type Router,
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
    layout?: 'app' | 'auth' | 'doc';
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
    path: '/projects/new',
    name: 'project-new',
    component: () => import('./pages/ProjectNewPage.vue'),
    meta: { sysAdmin: true, title: '새 프로젝트' },
  },
  {
    path: '/projects/:projectKey',
    name: 'project-home',
    component: () => import('./pages/ProjectHomePage.vue'),
    meta: { title: '프로젝트 홈' },
  },
  {
    path: '/projects/:projectKey/tables',
    name: 'project-tables',
    component: () => import('./pages/TablesPage.vue'),
    meta: { title: '테이블' },
  },
  {
    path: '/projects/:projectKey/tables/new',
    name: 'table-new',
    component: () => import('./pages/TableEditorPage.vue'),
    meta: { title: '새 테이블', rail: true },
  },
  {
    path: '/projects/:projectKey/tables/:tableId(\\d+)',
    name: 'table-edit',
    component: () => import('./pages/TableEditorPage.vue'),
    meta: { title: '테이블 편집기', rail: true },
  },
  {
    path: '/projects/:projectKey/export',
    name: 'project-export',
    component: () => import('./pages/DdlExportPage.vue'),
    meta: { title: 'DDL 내보내기' },
  },
  {
    path: '/projects/:projectKey/biz-areas',
    name: 'project-biz-areas',
    component: () => import('./pages/BizAreasPage.vue'),
    meta: { title: '업무구분' },
  },
  {
    path: '/projects/:projectKey/standards/terms',
    name: 'std-terms',
    component: () => import('./pages/TermsPage.vue'),
    meta: { title: '용어' },
  },
  {
    path: '/projects/:projectKey/standards/domain-classes',
    name: 'std-domain-classes',
    component: () => import('./pages/DomainClassesPage.vue'),
    meta: { title: '도메인분류' },
  },
  {
    path: '/projects/:projectKey/standards/domains',
    name: 'std-domains',
    component: () => import('./pages/DomainsPage.vue'),
    meta: { title: '도메인' },
  },
  {
    path: '/projects/:projectKey/standards/codes',
    name: 'std-codes',
    component: () => import('./pages/CodesPage.vue'),
    meta: { title: '코드' },
  },
  {
    path: '/projects/:projectKey/standards/default-columns',
    name: 'std-default-columns',
    component: () => import('./pages/DefaultColumnsPage.vue'),
    meta: { title: '기본컬럼' },
  },
  {
    path: '/projects/:projectKey/standards/approvals',
    name: 'std-approvals',
    component: () => import('./pages/ApprovalsPage.vue'),
    meta: { title: '승인 큐' },
  },
  {
    path: '/projects/:projectKey/standards/:kind/import',
    name: 'std-import',
    component: () => import('./pages/StdImportPage.vue'),
    meta: { title: '일괄 등록' },
  },
  {
    path: '/projects/:projectKey/settings',
    name: 'project-settings',
    component: () => import('./pages/ProjectSettingsPage.vue'),
    meta: { title: '프로젝트 설정' },
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
    path: '/admin/projects',
    name: 'admin-projects',
    component: () => import('./pages/AdminProjectsPage.vue'),
    meta: { sysAdmin: true, title: '프로젝트(관리)' },
  },
  {
    path: '/admin/templates',
    name: 'admin-templates',
    component: () => import('./pages/AdminTemplatesPage.vue'),
    meta: { sysAdmin: true, title: '템플릿' },
  },
  {
    // 설명서(T12.5): 로그인 전에도 열람(사용자 가이드). 설치·운영 가이드의 시스템 관리자 제한은 화면이 한다(CR-12 C4)
    path: '/manual/:id?',
    name: 'manual',
    component: () => import('./pages/ManualPage.vue'),
    meta: { public: true, layout: 'doc', title: '설명서' },
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

/** 앱에 있는 화면 경로인지(아직 없는 화면 링크를 404로 보내지 않기 위해, 예: C3 검토 도메인 목록 — 단계 6). */
let probe: Router | null = null;
export function hasScreen(path: string): boolean {
  probe ??= createRouter({ history: createMemoryHistory(), routes });
  return probe.resolve(path).name !== 'not-found';
}

export function createAppRouter(history: RouterHistory = createWebHistory()) {
  return createRouter({ history, routes });
}
