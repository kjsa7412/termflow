<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import AppSidebar from './AppSidebar.vue';
import AppTopbar from './AppTopbar.vue';

/**
 * 앱 셸(§10.2): 사이드바(240px) + 상단 바(48px) + 콘텐츠. 레일(56px)은 편집기 경로(`meta.rail`)에서 기본,
 * 그 외에는 사용자가 상단 바 버튼으로 전환한 값(브라우저 localStorage, 개인 편의 설정)을 쓴다.
 */
const RAIL_KEY = 'tf.sidebarRail';
const route = useRoute();
function stored(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) === '1';
  } catch {
    return false;
  }
}
const rail = ref(route.meta['rail'] === true || stored());
watch(
  () => route.meta['rail'],
  (v) => (rail.value = v === true || stored()),
);
function toggleRail(): void {
  rail.value = !rail.value;
  try {
    localStorage.setItem(RAIL_KEY, rail.value ? '1' : '0');
  } catch {
    /* 저장 불가 환경은 무시 */
  }
}
</script>

<template>
  <div :class="['app', { 'is-rail': rail }]">
    <AppSidebar />
    <div class="app-body">
      <AppTopbar @toggle-rail="toggleRail" />
      <main id="main" class="content" tabindex="-1">
        <slot />
      </main>
    </div>
  </div>
</template>
