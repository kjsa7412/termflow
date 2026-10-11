import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { api } from '../api/client.js';
import { createAppRouter } from '../router.js';
import { useSessionStore } from '../stores/session.js';
import { fakeFetch, json, problem, type Handler, untilRoute } from '../test-utils.js';
import AdminUsersPage from './AdminUsersPage.vue';
import LoginPage from './LoginPage.vue';
import MePage from './MePage.vue';

// T4.11 화면: 로그인(키보드만으로), 강제 비밀번호 변경, 사용자 관리(초기 비밀번호 1회 표시)
const ME = {
  user: { id: 1, loginId: 'admin', userNm: '시스템 관리자', isSysAdmin: true },
  mustChangePassword: false,
  projects: [],
};

async function setup(path: string, routes: Record<string, Handler>) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const f = fakeFetch({ 'GET /api/v1/auth/csrf': () => json(200, { token: 'T' }), ...routes });
  vi.stubGlobal('fetch', f.fetch);
  api.setCsrfToken(null);
  const router = createAppRouter(createMemoryHistory());
  await router.push(path);
  return { pinia, router, calls: f.calls };
}
beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('LoginPage', () => {
  it('키보드만으로 로그인: 아이디 입력 → 비밀번호 입력 → Enter 제출 → next 경로로 이동', async () => {
    const { pinia, router, calls } = await setup('/login?next=/admin/users', {
      'POST /api/v1/auth/login': () =>
        json(200, { user: ME.user, mustChangePassword: false, csrfToken: 'T2' }),
      'GET /api/v1/me': () => json(200, ME),
    });
    const w = mount(LoginPage, { global: { plugins: [pinia, router] }, attachTo: document.body });
    await flushPromises();
    expect(document.activeElement?.getAttribute('name')).toBe('loginId'); // 첫 칸 자동 포커스
    await w.get('input[name="loginId"]').setValue('admin');
    await w.get('input[name="password"]').setValue('secret-pw1');
    // Enter = form submit(버튼 클릭 없이)
    await w.get('form').trigger('submit');
    await flushPromises();
    const login = calls.find((c) => c.path === '/api/v1/auth/login')!;
    expect(login.body).toBe('loginId=admin&password=secret-pw1');
    expect(login.headers['x-xsrf-token']).toBe('T');
    await untilRoute(router, '/admin/users');
    expect(useSessionStore().user?.loginId).toBe('admin');
    w.unmount();
  });

  it('401: 같은 안내 문구 + 잠금 정책, 423: 잠금 알림(서버 남은 시간 문구)', async () => {
    let n = 0;
    const { pinia, router } = await setup('/login', {
      'POST /api/v1/auth/login': () =>
        ++n === 1
          ? problem(401, 'unauthorized', 'E_INVALID_CREDENTIALS')
          : problem(423, 'locked', 'E_LOCKED', {
              detail: '계정이 잠겼습니다. 15분 후 다시 시도하거나 관리자에게 해제를 요청하세요',
            }),
    });
    const w = mount(LoginPage, { global: { plugins: [pinia, router] } });
    await w.get('input[name="loginId"]').setValue('kim');
    await w.get('input[name="password"]').setValue('bad');
    await w.get('form').trigger('submit');
    await flushPromises();
    expect(w.get('[role="alert"]').text()).toContain('아이디 또는 비밀번호가 올바르지 않습니다');
    expect(w.get('[role="alert"]').text()).toContain('5회 연속 실패하면 계정이 15분간 잠깁니다');
    expect(w.get('input[name="password"]').classes()).toContain('is-invalid');
    expect((w.get('input[name="password"]').element as HTMLInputElement).value).toBe('');
    await w.get('input[name="password"]').setValue('bad2');
    await w.get('form').trigger('submit');
    await flushPromises();
    expect(w.get('.alert-warning').text()).toContain('15분 후 다시 시도');
  });

  it('로그인해 있다가 세션이 끊겨 오면 이유를 알리고, 직접 로그아웃하거나 처음 오면 알리지 않는다(CR-15 C16)', async () => {
    sessionStorage.setItem('tf.session', '1'); // 이 탭에서 로그인해 있었다
    const a = await setup('/login?next=/projects/RMS/tables/7', {
      'GET /api/v1/me': () => problem(401, 'unauthorized', 'E_UNAUTHORIZED'),
    });
    await useSessionStore().ensureLoaded();
    const w1 = mount(LoginPage, { global: { plugins: [a.pinia, a.router] } });
    expect(w1.find('[data-testid="session-expired"]').text()).toContain('자동으로 로그아웃');
    w1.unmount();
    // 한 번 보이면 지운다 — 다시 열면(처음 오는 것과 같음) 안내 없음
    const b = await setup('/login', {});
    const w2 = mount(LoginPage, { global: { plugins: [b.pinia, b.router] } });
    expect(w2.find('[data-testid="session-expired"]').exists()).toBe(false);
    // 직접 로그아웃은 표시를 먼저 지운다
    sessionStorage.setItem('tf.session', '1');
    const c = await setup('/login', {
      'POST /api/v1/auth/logout': () => new Response(null, { status: 204 }),
    });
    await useSessionStore().logout();
    const w3 = mount(LoginPage, { global: { plugins: [c.pinia, c.router] } });
    expect(w3.find('[data-testid="session-expired"]').exists()).toBe(false);
  });

  it('빈 입력은 서버를 부르지 않는다', async () => {
    const { pinia, router, calls } = await setup('/login', {});
    const w = mount(LoginPage, { global: { plugins: [pinia, router] } });
    await w.get('form').trigger('submit');
    await flushPromises();
    expect(calls.some((c) => c.path === '/api/v1/auth/login')).toBe(false);
    expect(w.text()).toContain('아이디와 비밀번호를 입력하세요');
  });
});

describe('MePage — 강제 변경 모드(/me?forcePassword=1)', () => {
  it('정책 안내·확인 불일치·충족 전 버튼 비활성, 변경 성공 → /projects', async () => {
    let changed = false;
    const { pinia, router, calls } = await setup('/me?forcePassword=1', {
      'PUT /api/v1/me/password': () => ((changed = true), new Response(null, { status: 204 })),
      'GET /api/v1/me': () => json(200, { ...ME, mustChangePassword: !changed }),
    });
    const session = useSessionStore();
    await session.refresh();
    const w = mount(MePage, { global: { plugins: [pinia, router] } });
    const submit = () => w.get('button[type="submit"]');
    expect(submit().attributes('disabled')).toBeDefined();
    await w.get('#pw-current').setValue('Init#pass12');
    await w.get('#pw-new').setValue('abcdefgh');
    expect(w.text()).toContain('영문·숫자·특수문자 중 2종류 이상');
    await w.get('#pw-new').setValue('admin#2026x');
    expect(w.text()).toContain('로그인 ID를 포함할 수 없습니다');
    await w.get('#pw-new').setValue('Fresh#2026ok');
    await w.get('#pw-confirm').setValue('Fresh#2026');
    expect(w.text()).toContain('새 비밀번호와 일치하지 않습니다');
    expect(submit().attributes('disabled')).toBeDefined();
    await w.get('#pw-confirm').setValue('Fresh#2026ok');
    expect(submit().attributes('disabled')).toBeUndefined();
    await w.get('form').trigger('submit');
    await flushPromises();
    expect(JSON.parse(calls.find((c) => c.method === 'PUT')!.body!)).toEqual({
      currentPassword: 'Init#pass12',
      newPassword: 'Fresh#2026ok',
    });
    await untilRoute(router, '/projects');
    expect(session.mustChangePassword).toBe(false);
  });

  it('서버 422(현재 비밀번호 불일치)를 해당 칸 오류로', async () => {
    const { pinia, router } = await setup('/me?forcePassword=1', {
      'PUT /api/v1/me/password': () =>
        problem(422, 'validation', 'E_VALIDATION', {
          errors: [
            {
              code: 'E_PW_CURRENT_MISMATCH',
              field: 'currentPassword',
              message: '현재 비밀번호가 올바르지 않습니다',
            },
          ],
        }),
      'GET /api/v1/me': () => json(200, { ...ME, mustChangePassword: true }),
    });
    await useSessionStore().refresh();
    const w = mount(MePage, { global: { plugins: [pinia, router] } });
    await w.get('#pw-current').setValue('wrong');
    await w.get('#pw-new').setValue('Fresh#2026ok');
    await w.get('#pw-confirm').setValue('Fresh#2026ok');
    await w.get('form').trigger('submit');
    await flushPromises();
    expect(w.get('#pw-current').classes()).toContain('is-invalid');
    expect(w.text()).toContain('현재 비밀번호가 올바르지 않습니다');
  });
});

describe('MePage — 외부 연동 접근 토큰(CR-18)', () => {
  const ITEM = {
    tokenId: 3,
    tokenNm: '내 PC',
    tokenPrefix: 'tfp_AbCd1234',
    createdAt: '2026-10-11 10:00:00',
    expiresAt: '2027-01-09 10:00:00',
    lastUsedAt: null,
    lastUsedIp: null,
    status: 'ACTIVE',
  };

  it('발급: 원문·연결 설정은 발급 직후 1회, 폐기는 확인 후', async () => {
    const raw = `tfp_${'x'.repeat(43)}`;
    let revoked = false;
    const { pinia, router, calls } = await setup('/me', {
      'GET /api/v1/me': () => json(200, ME),
      'GET /api/v1/me/tokens': () =>
        json(200, {
          enabled: true,
          mcpPath: '/mcp',
          items: revoked ? [{ ...ITEM, status: 'REVOKED' }] : [],
        }),
      'POST /api/v1/me/tokens': () => json(201, { item: ITEM, token: raw }),
      'DELETE /api/v1/me/tokens/3': () => ((revoked = true), new Response(null, { status: 204 })),
    });
    await useSessionStore().refresh();
    const w = mount(MePage, { global: { plugins: [pinia, router] }, attachTo: document.body });
    await flushPromises();
    expect(w.text()).toContain('발급한 토큰이 없습니다');
    await w.get('#token-nm').setValue('내 PC');
    await w.get('#token-days').setValue('30');
    await w.findAll('form').at(-1)!.trigger('submit');
    await flushPromises();
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/v1/me/tokens')!;
    expect(JSON.parse(post.body!)).toEqual({ tokenNm: '내 PC', expiresInDays: 30 });
    const shown = w.get('[data-testid="token-issued"]').text();
    expect(shown).toContain(raw);
    expect(shown).toContain('"url": "http://localhost:3000/mcp"');
    expect(shown).toContain(`"Authorization": "Bearer ${raw}"`);
    expect(w.text()).toContain('tfp_AbCd1234…');

    await w
      .findAll('button')
      .find((b) => b.text() === '폐기')!
      .trigger('click');
    await flushPromises();
    await w
      .findAll('button')
      .filter((b) => b.text() === '폐기')
      .at(-1)!
      .trigger('click');
    await flushPromises();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
    expect(w.text()).toContain('폐기');
    w.unmount();
  });

  it('서버에서 꺼져 있으면 안내만(발급 폼 없음)', async () => {
    const { pinia, router } = await setup('/me', {
      'GET /api/v1/me': () => json(200, ME),
      'GET /api/v1/me/tokens': () => json(200, { enabled: false, mcpPath: '/mcp', items: [] }),
    });
    await useSessionStore().refresh();
    const w = mount(MePage, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(w.text()).toContain('TERMFLOW_MCP_ENABLED');
    expect(w.find('#token-nm').exists()).toBe(false);
  });
});

describe('AdminUsersPage', () => {
  const page = (items: unknown[]) =>
    json(200, {
      items,
      page: 1,
      size: 20,
      total: items.length,
      counts: { all: items.length, active: 1, pwPending: 1, locked: 0, inactive: 0, sysAdmin: 1 },
    });
  const admin = {
    id: 1,
    loginId: 'admin',
    userNm: '시스템 관리자',
    email: null,
    isSysAdmin: true,
    isActive: true,
    pwChangeRequired: false,
    locked: false,
    lockedUntil: null,
    lastLoginAt: null,
    createdAt: '2026-09-28T09:00:00',
    projects: [],
  };
  const editor1 = {
    ...admin,
    id: 2,
    loginId: 'editor1',
    userNm: '편집자1',
    isSysAdmin: false,
    pwChangeRequired: true,
  };

  it('목록·건수 → 계정 생성(인라인 행) → 초기 비밀번호 1회 표시 → 닫으면 사라짐', async () => {
    let created = false;
    const { pinia, router, calls } = await setup('/admin/users', {
      'GET /api/v1/admin/users': () => page(created ? [admin, editor1] : [admin]),
      'POST /api/v1/admin/users': () => (
        (created = true),
        json(201, { user: editor1, temporaryPassword: 'Tf7qK2mW9x!a' })
      ),
    });
    const w = mount(AdminUsersPage, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(w.get('.page-title').text()).toContain('1');
    expect(w.text()).toContain('시스템 관리자');
    await w.get('.page-actions button').trigger('click');
    await w.get('input[aria-label="이름"]').setValue('편집자1');
    await w.get('input[aria-label="아이디"]').setValue('editor1');
    const createBtn = w
      .findAll('button')
      .find((b) => b.text().includes('생성 · 초기 비밀번호 발급'))!;
    await createBtn.trigger('click');
    await flushPromises();
    expect(
      JSON.parse(calls.find((c) => c.method === 'POST' && c.path === '/api/v1/admin/users')!.body!),
    ).toEqual({
      userNm: '편집자1',
      loginId: 'editor1',
      email: null,
      isSysAdmin: false,
    });
    expect(w.get('[data-testid="issued-password"]').text()).toBe('Tf7qK2mW9x!a');
    expect(w.text()).toContain('비밀번호 변경 대기');
    await w.get('button[aria-label="닫기"]').trigger('click');
    expect(w.find('[data-testid="issued-password"]').exists()).toBe(false);
  });

  it('아이디 중복 409는 입력행 아래 오류로', async () => {
    const { pinia, router } = await setup('/admin/users', {
      'GET /api/v1/admin/users': () => page([admin]),
      'POST /api/v1/admin/users': () => problem(409, 'duplicate-key', 'E_LOGIN_ID_DUP'),
    });
    const w = mount(AdminUsersPage, { global: { plugins: [pinia, router] } });
    await flushPromises();
    await w.get('.page-actions button').trigger('click');
    await w.get('input[aria-label="이름"]').setValue('중복');
    await w.get('input[aria-label="아이디"]').setValue('admin');
    await w
      .findAll('button')
      .find((b) => b.text().includes('생성 · 초기 비밀번호 발급'))!
      .trigger('click');
    await flushPromises();
    expect(w.text()).toContain("아이디 'admin'는 이미 사용 중입니다");
    expect(w.get('input[aria-label="아이디"]').classes()).toContain('is-invalid');
  });
});
