<script setup lang="ts">
import { RouterLink } from 'vue-router';
import { APP_NAME } from '@termflow/shared';
import { useSessionStore } from '../../stores/session.js';

/**
 * 문서 레이아웃(T12.5): 로그인 전에 설명서(`/manual`)를 볼 때의 껍데기 — 상단 바(브랜드 · 로그인)만 있고 사이드바가 없다.
 * 로그인한 사용자는 같은 화면을 앱 셸 안에서 본다(App.vue).
 */
const session = useSessionStore();
</script>

<template>
  <div class="doc-shell">
    <header class="topbar doc-shell-bar">
      <RouterLink class="brand" to="/login">
        <span class="brand-mark">TF</span><span class="brand-name">{{ APP_NAME }}</span>
      </RouterLink>
      <span class="topbar-crumb">설명서</span>
      <div class="topbar-right">
        <RouterLink v-if="!session.isLoggedIn" class="btn btn-primary btn-sm" to="/login"
          >로그인</RouterLink
        >
      </div>
    </header>
    <main id="main" class="content" tabindex="-1">
      <slot />
    </main>
  </div>
</template>
