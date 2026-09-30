<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useSessionStore } from '../../stores/session.js';
import TfIcon from '../ui/TfIcon.vue';
import AppSidebar from './AppSidebar.vue';
import AppTopbar from './AppTopbar.vue';

/**
 * 앱 셸(§10.2): 사이드바(240px) + 상단 바(48px) + 콘텐츠. 레일(56px)은 편집기 경로(`meta.rail`)에서 기본,
 * 그 외에는 사용자가 상단 바 버튼으로 전환한 값(브라우저 localStorage, 개인 편의 설정)을 쓴다.
 */
const RAIL_KEY = 'tf.sidebarRail';
const route = useRoute();
const session = useSessionStore();
/** 시스템 관리자가 템플릿(`/projects/{templateKey}/…`)을 편집 중이면 배너(§10.2). */
const editingTemplate = computed(() => {
  const key = route.params['projectKey'];
  return session.projects.find((p) => p.key === key && p.kind === 'TEMPLATE') ?? null;
});
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
      <main id="main" :class="['content', { 'is-flush': route.meta['rail'] === true }]" tabindex="-1">
        <div v-if="editingTemplate" class="alert alert-warning mb-4" role="status">
          <TfIcon name="layers" />
          <div class="alert-body">
            <div class="alert-title">
              템플릿 편집 중 — {{ editingTemplate.nm }}({{ editingTemplate.key }})
            </div>
            이미 만든 프로젝트에는 반영되지 않습니다(스냅샷 복사). 개정은 새 템플릿으로 게시하는
            것을 권장합니다.
          </div>
        </div>
        <slot />
      </main>
    </div>
  </div>
</template>
