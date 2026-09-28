/**
 * 권한 매트릭스(설계서 §7.3)를 데이터로 둔다(T4.7). `test/db/authz-matrix.test.ts`가 역할 6종 × 행을 자동 생성한다.
 * 이 단계(4)는 인증·내 계정·사용자 행만 채우고, 이후 단계가 프로젝트(`P/**`) 행을 추가한다.
 *
 * - `allow`: 허용 역할. 허용이면 `ok` 상태 중 하나, 거부면 익명 401 · 그 외 `deny`(기본 403, 프로젝트 비멤버 404).
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
}

export interface MatrixCtx {
  /** 사용자 관리 대상(픽스처 밖 전용 사용자) ID. */
  targetUserId: number;
  /** 케이스마다 다른 값(생성 요청의 loginId 등). */
  seq: () => number;
  fixturePassword: string;
}

export interface MatrixRow {
  /** §7.3 경로 표기(보고용). */
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  allow: readonly Role[];
  ok: readonly number[];
  deny?: number;
  run: (c: MatrixClient, ctx: MatrixCtx) => Promise<{ status: number; body: unknown }>;
}

const ALL: readonly Role[] = ROLES;
const LOGGED_IN: readonly Role[] = ['login', 'viewer', 'editor', 'pa', 'sa'];
const SA: readonly Role[] = ['sa'];

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
];
