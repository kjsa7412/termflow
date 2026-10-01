import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, type RouteLocationNormalized } from 'vue-router';
import { api } from '../api/client.js';
import { authGuard, createAppRouter } from '../router.js';
import { useSessionStore } from '../stores/session.js';
import { fakeFetch, json, problem, untilRoute } from '../test-utils.js';
import ManualPage from './ManualPage.vue';

// T12.5 제품 내 설명서: 로그인 전 열람(사용자 가이드), 설치·운영 가이드는 시스템 관리자만, 문서 안 링크는 라우터로
const USER = (isSysAdmin: boolean) => ({
  user: { id: 1, loginId: 'kim', userNm: '김', isSysAdmin },
  mustChangePassword: false,
  projects: [],
});
const GUIDE = encodeURIComponent('사용자_가이드');
const OPS = encodeURIComponent('설치_운영_가이드');

async function setup(path: string, me: ReturnType<typeof USER> | null) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const f = fakeFetch({
    'GET /api/v1/me': () => (me ? json(200, me) : problem(401, 'unauthorized', 'E_UNAUTHORIZED')),
  });
  vi.stubGlobal('fetch', f.fetch);
  vi.stubGlobal('scrollTo', vi.fn()); // jsdom 미구현(책을 열면 맨 위로)
  api.setCsrfToken(null);
  await useSessionStore(pinia).ensureLoaded();
  const router = createAppRouter(createMemoryHistory());
  await router.push(path);
  const w = mount(ManualPage, { global: { plugins: [pinia, router] }, attachTo: document.body });
  await flushPromises();
  return { router, w };
}
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('ManualPage', () => {
  it('라우트 /manual은 공개(비로그인·강제 변경 중에도 통과)', async () => {
    const router = createAppRouter(createMemoryHistory());
    const to = router.resolve('/manual/사용자_가이드') as unknown as RouteLocationNormalized;
    const s = { ensureLoaded: () => Promise.resolve(), isSysAdmin: false };
    expect(await authGuard(to, { ...s, isLoggedIn: false, mustChangePassword: false })).toBe(true);
    expect(await authGuard(to, { ...s, isLoggedIn: true, mustChangePassword: true })).toBe(true);
  });

  it('비로그인 /manual → 첫 권(사용자 가이드)으로, 목록에 설치·운영 가이드는 없다', async () => {
    const { router, w } = await setup('/manual', null);
    await untilRoute(router, `/manual/${GUIDE}`);
    await flushPromises();
    expect(w.get('[data-testid="manual-body"] h1').text()).toBe('TermFlow 사용자 가이드');
    const books = w.findAll('.manual-book').map((b) => b.text());
    expect(books).toEqual(['사용자 가이드']);
    // 목차는 h2·h3, 첫 절이 현재 절
    expect(w.findAll('.manual-toc a').length).toBeGreaterThan(5);
    expect(w.get('.manual-toc a[aria-current="true"]').text()).toMatch(/^1\. /);
    w.unmount();
  });

  it('비로그인으로 설치·운영 가이드 주소 → 본문 대신 로그인 안내', async () => {
    const { w } = await setup(`/manual/${OPS}`, null);
    expect(w.find('[data-testid="manual-body"]').exists()).toBe(false);
    expect(w.text()).toContain('시스템 관리자용 설명서입니다');
    expect(w.get('a.btn').attributes('href')).toContain('/login?next=');
    w.unmount();
  });

  it('일반 사용자도 설치·운영 가이드는 볼 수 없다', async () => {
    const { w } = await setup(`/manual/${OPS}`, USER(false));
    expect(w.text()).toContain('설치·운영 가이드는 시스템 관리자만 볼 수 있습니다');
    w.unmount();
  });

  it('시스템 관리자: 두 권 모두 목록에 있고 설치·운영 가이드 본문이 보인다', async () => {
    const { w } = await setup(`/manual/${OPS}`, USER(true));
    expect(w.findAll('.manual-book').map((b) => b.text())).toEqual([
      '사용자 가이드',
      '설치·운영 가이드관리자',
    ]);
    expect(w.get('[data-testid="manual-body"] h1').text()).toBe('TermFlow 설치·운영 가이드');
    // 코드 블록에 복사 단추
    expect(w.findAll('pre.doc-pre .doc-copy').length).toBeGreaterThan(0);
    w.unmount();
  });

  it('없는 책 → 찾을 수 없음', async () => {
    const { w } = await setup('/manual/없는책', null);
    expect(w.text()).toContain('설명서를 찾을 수 없습니다');
    w.unmount();
  });

  it('본문 안 다른 책 링크(data-route)는 라우터로 이동한다', async () => {
    const { router, w } = await setup(`/manual/${GUIDE}`, USER(true));
    const link = w
      .findAll('[data-testid="manual-body"] a[data-route]')
      .find((a) => a.attributes('href')!.startsWith(`/manual/${OPS}`));
    expect(link, '사용자 가이드 → 설치·운영 가이드 링크').toBeTruthy();
    await link!.trigger('click', { button: 0 });
    await untilRoute(router, `/manual/${OPS}`);
    await flushPromises();
    expect(w.get('[data-testid="manual-body"] h1').text()).toBe('TermFlow 설치·운영 가이드');
    w.unmount();
  });
});
