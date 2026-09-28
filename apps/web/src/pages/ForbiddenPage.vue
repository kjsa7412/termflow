<script setup lang="ts">
import { RouterLink } from 'vue-router';
import EmptyState from '../components/ui/EmptyState.vue';

/** 권한 없음(§10.5: 멤버이지만 역할 부족 403, 시스템 관리자 화면). */
</script>

<template>
  <EmptyState
    icon="lock"
    title="권한이 없습니다"
    desc="이 화면을 볼 수 있는 역할이 아닙니다. 필요하면 관리자에게 요청하세요."
  >
    <RouterLink class="btn btn-secondary" to="/projects">프로젝트 목록으로</RouterLink>
  </EmptyState>
</template>
