/**
 * 권한 매트릭스(설계서 §7.3)를 데이터로 둔다(T4.7). `test/db/authz-matrix.test.ts`가 역할 6종 × 행을 자동 생성한다.
 * 단계 4는 인증·내 계정·사용자 행, 단계 5는 프로젝트·멤버·업무구분·시스템(프로젝트·템플릿) 행을 채운다.
 * `P` = `/projects/PRJA`(std_small: pa=ADMIN, editor=EDITOR, viewer=VIEWER, nobody=비멤버 → 404).
 *
 * - `allow`: 허용 역할. 허용이면 `ok` 상태 중 하나(업무 규칙 409·422도 "핸들러 도달" = 허용 증명), 거부면 익명 401 ·
 *   그 외 `denyByRole[role]` → `deny`(기본 403). 프로젝트 행은 비멤버(login) 404.
 * - `run`: 요청 1건(요청에 필요한 ID는 ctx에서). 비-GET은 클라이언트가 CSRF 헤더를 자동으로 붙인다.
 */
export const ROLES = ['anon', 'login', 'viewer', 'editor', 'pa', 'sa'] as const;
export type Role = (typeof ROLES)[number];

/** 역할별 로그인 계정(std_small 픽스처 + 무소속 사용자 `nobody`). anon은 로그인하지 않는다. */
export const ROLE_LOGIN: Record<Exclude<Role, 'anon'>, string> = {
  login: 'nobody',
  viewer: 'viewer',
  editor: 'editor',
  pa: 'pa',
  sa: 'sysadmin',
};

export interface MatrixClient {
  get(path: string): Promise<{ status: number; body: unknown }>;
  post(
    path: string,
    body?: object,
    opts?: { form?: boolean },
  ): Promise<{ status: number; body: unknown }>;
  put(path: string, body?: object): Promise<{ status: number; body: unknown }>;
  delete(path: string, body?: object): Promise<{ status: number; body: unknown }>;
}

export interface MatrixCtx {
  /** 사용자 관리 대상(픽스처 밖 전용 사용자) ID. */
  targetUserId: number;
  /** 케이스마다 다른 값(생성 요청의 loginId 등). */
  seq: () => number;
  fixturePassword: string;
  /** PRJA 업무구분(RP: 테이블 1 → 잠김, PS: 테이블 0). */
  bizRpId: number;
  bizPsId: number;
  /** PRJA 프로젝트 관리자(유일한 ADMIN) user_id — 제거 시도는 409 E_LAST_PROJECT_ADMIN. */
  paUserId: number;
}

export interface MatrixRow {
  /** §7.3 경로 표기(보고용). */
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  allow: readonly Role[];
  ok: readonly number[];
  deny?: number;
  denyByRole?: Partial<Record<Role, number>>;
  run: (c: MatrixClient, ctx: MatrixCtx) => Promise<{ status: number; body: unknown }>;
}

const ALL: readonly Role[] = ROLES;
const LOGGED_IN: readonly Role[] = ['login', 'viewer', 'editor', 'pa', 'sa'];
const SA: readonly Role[] = ['sa'];
const VIEWER_UP: readonly Role[] = ['viewer', 'editor', 'pa', 'sa'];
const PA_UP: readonly Role[] = ['pa', 'sa'];
/** 프로젝트 행: 비멤버(login)는 403이 아니라 404(§7.3 존재 노출 방지). */
const P_DENY = { login: 404 } as const;
const P = '/api/v1/projects/PRJA';
const EMPTY_IMPORTS = {
  bizAreas: { source: 'EMPTY' },
  terms: { source: 'EMPTY' },
  domainClasses: { source: 'EMPTY' },
  domains: { source: 'EMPTY' },
  codes: { source: 'EMPTY' },
  defaultColSets: { source: 'EMPTY' },
};
const SETTINGS = {
  projectNm: '프로젝트 A',
  description: null,
  defaultDialect: 'POSTGRESQL',
  includeDefaultCols: true,
  defaultColSetId: null,
};

export const AUTHZ_MATRIX: readonly MatrixRow[] = [
  // ── 인증(§7.3 1행) ─────────────────────────────────────────────
  {
    path: '/auth/csrf',
    method: 'GET',
    allow: ALL,
    ok: [200],
    run: (c) => c.get('/api/v1/auth/csrf'),
  },
  {
    path: '/auth/login',
    method: 'POST',
    allow: ALL,
    ok: [200],
    run: (c, x) =>
      c.post(
        '/api/v1/auth/login',
        { loginId: 'viewer', password: x.fixturePassword },
        { form: true },
      ),
  },
  // ── 내 계정(§7.3 2행) ──────────────────────────────────────────
  {
    path: '/auth/logout',
    method: 'POST',
    allow: LOGGED_IN,
    ok: [204],
    run: (c) => c.post('/api/v1/auth/logout'),
  },
  { path: '/me', method: 'GET', allow: LOGGED_IN, ok: [200], run: (c) => c.get('/api/v1/me') },
  {
    path: '/me/password',
    method: 'PUT',
    allow: LOGGED_IN,
    // 현재 비밀번호를 일부러 틀려 비밀번호를 바꾸지 않는다(도달 = 422)
    ok: [422],
    run: (c) =>
      c.put('/api/v1/me/password', {
        currentPassword: 'not-the-current-1',
        newPassword: 'Matrix#2026pw',
      }),
  },
  // ── 시스템·사용자(§7.3 마지막 행) ────────────────────────────────
  {
    path: '/admin/users',
    method: 'GET',
    allow: SA,
    ok: [200],
    run: (c) => c.get('/api/v1/admin/users'),
  },
  {
    path: '/admin/users',
    method: 'POST',
    allow: SA,
    ok: [201],
    run: (c, x) => c.post('/api/v1/admin/users', { loginId: `mx${x.seq()}`, userNm: '매트릭스' }),
  },
  {
    path: '/admin/users/{id}',
    method: 'GET',
    allow: SA,
    ok: [200],
    run: (c, x) => c.get(`/api/v1/admin/users/${x.targetUserId}`),
  },
  {
    path: '/admin/users/{id}',
    method: 'PUT',
    allow: SA,
    ok: [200],
    run: (c, x) =>
      c.put(`/api/v1/admin/users/${x.targetUserId}`, {
        userNm: '대상',
        email: null,
        isSysAdmin: false,
      }),
  },
  {
    path: '/admin/users/{id}/active',
    method: 'PUT',
    allow: SA,
    ok: [200],
    run: (c, x) => c.put(`/api/v1/admin/users/${x.targetUserId}/active`, { isActive: true }),
  },
  {
    path: '/admin/users/{id}/reset-password',
    method: 'POST',
    allow: SA,
    ok: [200],
    run: (c, x) => c.post(`/api/v1/admin/users/${x.targetUserId}/reset-password`),
  },
  {
    path: '/admin/users/{id}/unlock',
    method: 'POST',
    allow: SA,
    ok: [200],
    run: (c, x) => c.post(`/api/v1/admin/users/${x.targetUserId}/unlock`),
  },

  // ── 프로젝트 전역(§7.3 3·4행) ─────────────────────────────────────
  {
    path: '/projects',
    method: 'GET',
    allow: LOGGED_IN,
    ok: [200],
    run: (c) => c.get('/api/v1/projects'),
  },
  {
    path: '/projects/copy-sources',
    method: 'GET',
    allow: LOGGED_IN,
    ok: [200],
    run: (c) => c.get('/api/v1/projects/copy-sources'),
  },
  {
    path: '/projects/check-key',
    method: 'GET',
    allow: SA,
    ok: [200],
    run: (c) => c.get('/api/v1/projects/check-key?key=MXNEW'),
  },
  {
    path: '/projects/copy-preview',
    method: 'POST',
    allow: SA,
    ok: [200],
    run: (c) => c.post('/api/v1/projects/copy-preview', { imports: EMPTY_IMPORTS }),
  },
  {
    path: '/projects',
    method: 'POST',
    allow: SA,
    ok: [201],
    run: (c, x) =>
      c.post('/api/v1/projects', {
        projectKey: `MX${x.seq()}`,
        projectNm: '매트릭스',
        imports: EMPTY_IMPORTS,
      }),
  },
  // ── P 조회(§7.3 5행) · P/settings·copy-log ──────────────────────
  {
    path: 'P',
    method: 'GET',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c) => c.get(P),
  },
  {
    path: 'P/settings',
    method: 'GET',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c) => c.get(`${P}/settings`),
  },
  {
    path: 'P/settings',
    method: 'PUT',
    allow: PA_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c) => c.put(`${P}/settings`, SETTINGS),
  },
  {
    path: 'P/copy-log',
    method: 'GET',
    allow: PA_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c) => c.get(`${P}/copy-log`),
  },
  // ── 멤버(§7.3 P/members/**) ─────────────────────────────────────
  {
    path: 'P/members',
    method: 'GET',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c) => c.get(`${P}/members`),
  },
  {
    path: 'P/member-candidates',
    method: 'GET',
    allow: PA_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c) => c.get(`${P}/member-candidates?q=`),
  },
  {
    path: 'P/members',
    method: 'POST',
    allow: PA_UP,
    // 두 번째 허용 역할은 이미 멤버 → 409(핸들러 도달)
    ok: [201, 409],
    denyByRole: P_DENY,
    run: (c, x) => c.post(`${P}/members`, { userId: x.targetUserId, role: 'VIEWER' }),
  },
  {
    path: 'P/members/{userId}',
    method: 'PUT',
    allow: PA_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c, x) => c.put(`${P}/members/${x.paUserId}`, { role: 'ADMIN' }),
  },
  {
    path: 'P/members/{userId}',
    method: 'DELETE',
    allow: PA_UP,
    // 유일한 프로젝트 관리자 제거 시도 → 409 E_LAST_PROJECT_ADMIN(핸들러 도달, 상태 불변)
    ok: [409],
    denyByRole: P_DENY,
    run: (c, x) => c.delete(`${P}/members/${x.paUserId}`),
  },
  // ── 업무구분(§7.3 P/biz-areas) ──────────────────────────────────
  {
    path: 'P/biz-areas',
    method: 'GET',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c) => c.get(`${P}/biz-areas`),
  },
  {
    path: 'P/biz-areas',
    method: 'POST',
    allow: PA_UP,
    ok: [201],
    denyByRole: P_DENY,
    run: (c, x) => c.post(`${P}/biz-areas`, { bizCd: `MX${x.seq()}`, bizNm: '매트릭스' }),
  },
  {
    path: 'P/biz-areas/{id}',
    method: 'PUT',
    allow: PA_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c, x) =>
      c.put(`${P}/biz-areas/${x.bizPsId}`, {
        bizCd: 'PS',
        bizNm: '인사',
        tablePrefix: 'PS_',
        sortNo: 2,
        useYn: true,
      }),
  },
  {
    path: 'P/biz-areas/{id}/delete-preview',
    method: 'GET',
    allow: PA_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c, x) => c.get(`${P}/biz-areas/${x.bizPsId}/delete-preview`),
  },
  {
    path: 'P/biz-areas/{id}',
    method: 'DELETE',
    allow: PA_UP,
    // 테이블이 있는 RP → 409 E_BIZ_AREA_IN_USE(핸들러 도달, 상태 불변)
    ok: [409],
    denyByRole: P_DENY,
    run: (c, x) => c.delete(`${P}/biz-areas/${x.bizRpId}`),
  },
  // ── 시스템 › 프로젝트·템플릿(§7.3 마지막 행) ──────────────────────
  {
    path: '/admin/projects',
    method: 'GET',
    allow: SA,
    ok: [200],
    run: (c) => c.get('/api/v1/admin/projects'),
  },
  {
    path: '/admin/projects/{key}/status',
    method: 'PUT',
    allow: SA,
    ok: [200],
    run: (c) => c.put('/api/v1/admin/projects/PRJB/status', { status: 'ACTIVE' }),
  },
  {
    path: '/admin/projects/{key}',
    method: 'DELETE',
    allow: SA,
    // ACTIVE 프로젝트 → 409 E_PROJECT_ACTIVE(삭제되지 않음)
    ok: [409],
    run: (c) => c.delete('/api/v1/admin/projects/PRJA', { confirmKey: 'PRJA' }),
  },
  {
    path: '/admin/templates',
    method: 'GET',
    allow: SA,
    ok: [200],
    run: (c) => c.get('/api/v1/admin/templates'),
  },
  {
    path: '/admin/templates',
    method: 'POST',
    allow: SA,
    ok: [201],
    run: (c, x) =>
      c.post('/api/v1/admin/templates', {
        sourceProjectKey: 'PRJB',
        projectKey: `MXT${x.seq()}`,
        projectNm: '매트릭스 템플릿',
      }),
  },
  {
    path: '/admin/templates/{key}/status',
    method: 'PUT',
    allow: SA,
    ok: [200],
    run: (c) => c.put('/api/v1/admin/templates/STDS/status', { status: 'ACTIVE' }),
  },
  {
    path: '/admin/templates/{key}',
    method: 'DELETE',
    allow: SA,
    // 파생 프로젝트(PRJA)가 있는 STDS → 409 E_TEMPLATE_IN_USE(삭제되지 않음)
    ok: [409],
    run: (c) => c.delete('/api/v1/admin/templates/STDS', { confirmKey: 'STDS' }),
  },
];
