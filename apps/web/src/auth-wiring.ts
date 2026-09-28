import type { Router } from 'vue-router';
import type { ApiClient } from './api/client.js';
import { authGuard } from './router.js';
import type { useSessionStore } from './stores/session.js';

type Session = ReturnType<typeof useSessionStore>;

/**
 * 라우터 가드·API 오류 처리기 연결(T4.10, §7.4). main.ts와 테스트가 같은 배선을 쓴다.
 *  - 모든 이동 전 `authGuard`(비로그인 → `/login?next=`, 강제 변경 → `/me?forcePassword=1`)
 *  - API 401(세션 만료) → 전역 상태 초기화 후 `/login?next=현재경로`, 로그인하면 원래 경로로 복귀
 *  - API 403 password-change-required → 강제 변경 화면
 */
export function installAuth(router: Router, session: Session, client: ApiClient): void {
  router.beforeEach((to) => authGuard(to, session));
  client.configure({
    onUnauthorized: () => {
      if (!session.isLoggedIn) return;
      session.clear();
      const here = router.currentRoute.value;
      if (!here.meta.public) void router.push({ path: '/login', query: { next: here.fullPath } });
    },
    onPasswordChangeRequired: () => {
      session.mustChangePassword = true;
      void router.push({ path: '/me', query: { forcePassword: '1' } });
    },
  });
}
