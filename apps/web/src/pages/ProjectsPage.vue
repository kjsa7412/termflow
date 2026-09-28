<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { ROLE_LABEL } from '../components/layout/labels.js';
import EmptyState from '../components/ui/EmptyState.vue';
import TfBadge from '../components/ui/TfBadge.vue';
import { useSessionStore } from '../stores/session.js';

/**
 * 프로젝트 목록(`/projects`, 목업 02_projects의 카드 골격). 단계 4는 `/me`의 소속 프로젝트로 카드만 그린다.
 * 업무구분 칩·테이블 수·최근 변경·[새 프로젝트](마법사)는 단계 5(`GET /projects`, T5.x)에서 채운다.
 */
const session = useSessionStore();
const projects = computed(() => session.projects.filter((p) => p.kind === 'PROJECT'));
const templates = computed(() => session.projects.filter((p) => p.kind === 'TEMPLATE'));
</script>

<template>
  <div class="page-header">
    <div>
      <h1 class="page-title">
        프로젝트 <span class="count-pill">{{ projects.length }}</span>
      </h1>
      <p class="page-desc">
        {{ session.isSysAdmin ? '모든 프로젝트(시스템 관리자)' : '내가 멤버인 프로젝트' }}입니다.
        프로젝트마다 표준 사전·업무구분·테이블이 따로 있습니다.
      </p>
    </div>
  </div>

  <div v-if="projects.length" class="project-grid">
    <RouterLink
      v-for="p in projects"
      :key="p.key"
      class="card project-card"
      :to="`/projects/${p.key}`"
    >
      <div class="row">
        <span class="project-key">{{ p.key }}</span>
        <span class="project-card-title">{{ p.nm }}</span>
      </div>
      <div class="project-meta">
        <span>{{ ROLE_LABEL[p.role] }}</span>
        <TfBadge v-if="p.status === 'ARCHIVED'" kind="draft">보관</TfBadge>
      </div>
    </RouterLink>
  </div>
  <EmptyState
    v-else
    icon="folder"
    title="소속된 프로젝트가 없습니다"
    :desc="
      session.isSysAdmin
        ? '프로젝트 생성 마법사에서 표준 템플릿을 골라 첫 프로젝트를 만들 수 있습니다.'
        : '프로젝트 관리자에게 멤버 추가를 요청하세요.'
    "
  />

  <section v-if="session.isSysAdmin && templates.length" class="section mt-6">
    <h2 class="section-title">
      표준 템플릿 <span class="count-pill">{{ templates.length }}</span>
    </h2>
    <div class="project-grid">
      <div v-for="t in templates" :key="t.key" class="card project-card">
        <div class="row">
          <span class="project-key">{{ t.key }}</span>
          <span class="project-card-title">{{ t.nm }}</span>
        </div>
        <div class="project-meta"><span>읽기 전용 원본 · 새 프로젝트에 표준을 공급</span></div>
      </div>
    </div>
  </section>
</template>
