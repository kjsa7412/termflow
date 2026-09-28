import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { api } from '../api/client.js';
import { createAppRouter } from '../router.js';
import { useSessionStore } from '../stores/session.js';
import { fakeFetch, json, problem, type Handler } from '../test-utils.js';
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
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/admin/users'));
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
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/projects'));
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
