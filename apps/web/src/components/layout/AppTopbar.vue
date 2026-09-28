<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { useSessionStore } from '../../stores/session.js';
import { useToastStore } from '../../stores/toast.js';
import TfIcon from '../ui/TfIcon.vue';
import TfPopover from '../ui/TfPopover.vue';

/**
 * 상단 바(§10.2, 48px): 사이드바 접기 · 전역 검색 자리(현재 프로젝트 범위, 단계 6) · 사용자 메뉴(이름·시스템 관리자 표시,
 * 내 계정, 로그아웃). 목업의 테마 전환은 제품에 넣지 않는다(D16).
 */
defineEmits<{ toggleRail: [] }>();
const session = useSessionStore();
const toast = useToastStore();
const route = useRoute();
const router = useRouter();
const inProject = computed(() => Boolean(route.params['projectKey']));
const initial = computed(() => session.user?.userNm.slice(0, 1) ?? '?');

async function logout(close: () => void): Promise<void> {
  close();
  try {
    await session.logout();
  } finally {
    await router.push('/login');
    toast.info('로그아웃했습니다');
  }
}
</script>

<template>
  <header class="topbar">
    <button
      class="btn btn-ghost btn-icon"
      type="button"
      title="사이드바 접기/펼치기"
      aria-label="사이드바 접기/펼치기"
      @click="$emit('toggleRail')"
    >
      <TfIcon name="sidebar" />
    </button>
    <div class="topbar-search">
      <TfIcon name="search" />
      <input
        class="input"
        type="search"
        :disabled="!inProject"
        :placeholder="
          inProject
            ? '이 프로젝트에서 용어 · 도메인 · 테이블 검색'
            : '프로젝트를 선택하면 검색할 수 있습니다'
        "
        aria-label="전역 검색(현재 프로젝트 범위)"
      />
      <span class="kbd">/</span>
    </div>
    <div class="topbar-right">
      <TfPopover align="right">
        <template #trigger="{ toggle, open, menuId }">
          <button
            class="user-btn"
            type="button"
            aria-haspopup="menu"
            :aria-expanded="open"
            :aria-controls="menuId"
            @click="toggle"
          >
            <span class="avatar">{{ initial }}</span>
            <span>{{ session.user?.userNm }}</span>
            <span v-if="session.isSysAdmin" class="role-chip">시스템 관리자</span>
            <TfIcon name="chevron-down" size="sm" />
          </button>
        </template>
        <template #default="{ close }">
          <div class="dropdown-label">
            {{ session.user?.loginId }}{{ session.isSysAdmin ? ' · 시스템 관리자' : '' }}
          </div>
          <RouterLink class="dropdown-item" to="/me" role="menuitem" @click="close()">
            <TfIcon name="user" />내 계정
          </RouterLink>
          <button class="dropdown-item" type="button" role="menuitem" @click="logout(close)">
            <TfIcon name="log-out" />로그아웃
          </button>
        </template>
      </TfPopover>
    </div>
  </header>
</template>
