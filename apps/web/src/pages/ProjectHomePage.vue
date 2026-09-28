<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { ROLE_LABEL } from '../components/layout/labels.js';
import EmptyState from '../components/ui/EmptyState.vue';
import { useSessionStore } from '../stores/session.js';

/**
 * 프로젝트 홈(`/projects/{key}`) 자리. 대시보드(목업 03_dashboard: 업무구분별 테이블 수·최근 변경·검토 배너)는
 * 단계 5(`GET P`)에서 채운다. 소속이 아닌 키는 404 화면과 같은 문구(존재 노출 방지, §10.5).
 */
const route = useRoute();
const session = useSessionStore();
const project = computed(() =>
  session.projects.find((p) => p.key === route.params['projectKey'] && p.kind === 'PROJECT'),
);
</script>

<template>
  <template v-if="project">
    <div class="page-header">
      <div>
        <div class="breadcrumb">
          <span>{{ project.key }}</span
          ><span>›</span><span>홈</span>
        </div>
        <h1 class="page-title">
          <span class="project-key">{{ project.key }}</span
          >{{ project.nm }}
        </h1>
        <p class="page-desc">내 역할: {{ ROLE_LABEL[project.role] }}</p>
      </div>
    </div>
    <EmptyState
      icon="home"
      title="프로젝트 홈"
      desc="업무구분별 테이블 수·최근 변경·검토 필요 항목 요약이 이 자리에 표시됩니다."
    />
  </template>
  <EmptyState
    v-else
    icon="folder"
    title="프로젝트를 찾을 수 없습니다"
    desc="주소가 잘못되었거나 이 프로젝트의 멤버가 아닙니다."
  >
    <RouterLink class="btn btn-secondary" to="/projects">프로젝트 목록으로</RouterLink>
  </EmptyState>
</template>
