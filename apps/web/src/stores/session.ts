import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { MyProject, SessionUser } from '@termflow/shared';
import { authApi } from '../api/auth.js';
import { ApiError, api, type ApiClient } from '../api/client.js';

/**
 * 세션 스토어(§2.5.6 `session`, T4.10). 서버 세션이 진실이고 여기는 `/me` 결과의 캐시다.
 * 새로고침 후 첫 라우팅에서 `ensureLoaded()`가 `/me`를 1회 부른다(401이면 비로그인).
 */
export const useSessionStore = defineStore('session', () => {
  const user = ref<SessionUser | null>(null);
  const mustChangePassword = ref(false);
  const projects = ref<MyProject[]>([]);
  const loaded = ref(false);
  let client: ApiClient = api;
  let pending: Promise<void> | null = null;

  const isLoggedIn = computed(() => user.value !== null);
  const isSysAdmin = computed(() => user.value?.isSysAdmin === true);

  function useClient(c: ApiClient): void {
    client = c;
  }

  async function refresh(): Promise<void> {
    try {
      const me = await authApi(client).me();
      user.value = me.user;
      mustChangePassword.value = me.mustChangePassword;
      projects.value = me.projects;
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) throw e;
      clear();
    } finally {
      loaded.value = true;
    }
  }

  function ensureLoaded(): Promise<void> {
    if (loaded.value) return Promise.resolve();
    pending ??= refresh().finally(() => {
      pending = null;
    });
    return pending;
  }

  async function login(loginId: string, password: string): Promise<void> {
    const res = await authApi(client).login(loginId, password);
    user.value = res.user;
    mustChangePassword.value = res.mustChangePassword;
    loaded.value = true;
    await refresh();
  }

  async function logout(): Promise<void> {
    try {
      await authApi(client).logout();
    } finally {
      clear();
    }
  }

  async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await authApi(client).changePassword(currentPassword, newPassword);
    mustChangePassword.value = false;
    await refresh();
  }

  /** 세션 만료·로그아웃: 전역 상태 초기화(localStorage 임시저장은 유지, §7.4). */
  function clear(): void {
    user.value = null;
    mustChangePassword.value = false;
    projects.value = [];
    loaded.value = true;
  }

  return {
    user,
    mustChangePassword,
    projects,
    loaded,
    isLoggedIn,
    isSysAdmin,
    useClient,
    refresh,
    ensureLoaded,
    login,
    logout,
    changePassword,
    clear,
  };
});
