<script setup lang="ts">
import { RouterLink } from 'vue-router';
import EmptyState from '../components/ui/EmptyState.vue';

/** 404(§10.5). 비멤버 프로젝트도 같은 화면(존재 노출 방지). */
</script>

<template>
  <EmptyState
    icon="alert-circle"
    title="페이지를 찾을 수 없습니다"
    desc="주소가 잘못되었거나 삭제된 화면입니다."
  >
    <RouterLink class="btn btn-secondary" to="/projects">프로젝트 목록으로</RouterLink>
  </EmptyState>
</template>
