<script setup lang="ts">
import { computed, watch } from 'vue';
import { RouterView, useRoute } from 'vue-router';
import { APP_NAME } from '@termflow/shared';
import AppShell from './components/layout/AppShell.vue';
import ToastRegion from './components/ui/ToastRegion.vue';

/** 레이아웃 선택: 로그인·강제 비밀번호 변경은 가운데 카드(`.auth`), 그 외는 앱 셸(§10.2). */
const route = useRoute();
const authLayout = computed(
  () =>
    route.meta.layout === 'auth' || (route.path === '/me' && route.query['forcePassword'] === '1'),
);
watch(
  () => route.meta.title,
  (t) => (document.title = t ? `${APP_NAME} · ${t}` : APP_NAME),
  { immediate: true },
);
</script>

<template>
  <div v-if="authLayout" class="auth">
    <RouterView />
  </div>
  <AppShell v-else>
    <RouterView />
  </AppShell>
  <ToastRegion />
</template>
