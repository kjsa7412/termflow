<script setup lang="ts">
import { computed, watch } from 'vue';
import { RouterView, useRoute } from 'vue-router';
import { APP_NAME } from '@termflow/shared';
import AppShell from './components/layout/AppShell.vue';
import DocShell from './components/layout/DocShell.vue';
import ToastRegion from './components/ui/ToastRegion.vue';
import { useSessionStore } from './stores/session.js';

/**
 * 레이아웃 선택: 로그인·강제 비밀번호 변경은 가운데 카드(`.auth`), 설명서(`meta.layout = 'doc'`)는 로그인 전·강제 변경 중이면
 * 문서 껍데기(T12.5), 그 외는 앱 셸(§10.2).
 */
const route = useRoute();
const session = useSessionStore();
const authLayout = computed(
  () =>
    route.meta.layout === 'auth' || (route.path === '/me' && route.query['forcePassword'] === '1'),
);
const docLayout = computed(
  () => route.meta.layout === 'doc' && (!session.isLoggedIn || session.mustChangePassword),
);
watch(
  () => route.meta.title,
  (t) => (document.title = t ? `${APP_NAME} · ${t}` : APP_NAME),
  { immediate: true },
);
</script>

<template>
  <!-- 첫 이동이 끝나기 전(route.matched 비어 있음)에는 레이아웃을 정하지 않는다 — 로그인·설명서 화면 앞에 앱 셸이 잠깐 보이지 않게 -->
  <template v-if="route.matched.length === 0" />
  <div v-else-if="authLayout" class="auth">
    <RouterView />
  </div>
  <DocShell v-else-if="docLayout">
    <RouterView />
  </DocShell>
  <AppShell v-else>
    <RouterView />
  </AppShell>
  <ToastRegion />
</template>
