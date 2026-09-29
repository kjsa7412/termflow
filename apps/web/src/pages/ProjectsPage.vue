<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import type { ProjectCard } from '@termflow/shared';
import { projectsApi } from '../api/projects.js';
import { ROLE_LABEL, shortDateTime } from '../components/layout/labels.js';
import EmptyState from '../components/ui/EmptyState.vue';
import TfBadge from '../components/ui/TfBadge.vue';
import TfIcon from '../components/ui/TfIcon.vue';
import TfSkeleton from '../components/ui/TfSkeleton.vue';
import { useSessionStore } from '../stores/session.js';
import { useToastStore } from '../stores/toast.js';

/**
 * 프로젝트 목록(`/projects`, 목업 02_projects, §10.1): 카드(키·이름·내 역할·업무구분 칩·테이블 수·멤버·최근 변경).
 * 소속만(시스템 관리자는 전체), 템플릿은 나오지 않는다. 필터: 내 프로젝트 / 전체(SA) / 보관 포함.
 */
const session = useSessionStore();
const toast = useToastStore();
const api = projectsApi();

type Filter = 'mine' | 'all' | 'archived';
const filter = ref<Filter>(session.isSysAdmin ? 'all' : 'mine');
const q = ref('');
const cards = ref<ProjectCard[]>([]);
const loading = ref(true);

async function load(): Promise<void> {
  loading.value = true;
  try {
    cards.value = await api.list({
      q: q.value.trim() || undefined,
      mine: filter.value === 'mine' && session.isSysAdmin,
      includeArchived: filter.value === 'archived',
    });
  } catch {
    toast.error('프로젝트 목록을 불러오지 못했습니다');
  } finally {
    loading.value = false;
  }
}
onMounted(load);
watch(filter, load);
let debounce: ReturnType<typeof setTimeout> | undefined;
watch(q, () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => void load(), 300);
});

const visible = computed(() =>
  filter.value === 'archived' ? cards.value.filter((c) => c.status === 'ARCHIVED') : cards.value,
);
const segments = computed(() =>
  (
    [
      { value: 'mine', label: '내 프로젝트' },
      ...(session.isSysAdmin ? [{ value: 'all', label: '전체' }] : []),
      { value: 'archived', label: '보관됨' },
    ] as { value: Filter; label: string }[]
  ).map((s) => s),
);
const dialectLabel = (d: string) => (d === 'POSTGRESQL' ? 'PostgreSQL' : d);
</script>

<template>
  <div class="page-header">
    <div>
      <h1 class="page-title">
        프로젝트 <span class="count-pill">{{ visible.length }}</span>
      </h1>
      <p class="page-desc">
        프로젝트는 하나의 사업에서 DB 스키마를 구성하는 작업 공간입니다. 표준
        사전·업무구분·테이블·멤버를 프로젝트마다 따로 가집니다. 이름이 같은 테이블도 프로젝트가
        다르면 컬럼·타입이 다를 수 있습니다.
      </p>
    </div>
    <div v-if="session.isSysAdmin" class="page-actions">
      <RouterLink class="btn btn-primary" to="/projects/new"
        ><TfIcon name="plus" />새 프로젝트</RouterLink
      >
    </div>
  </div>

  <div class="toolbar">
    <div class="input-wrap w-320">
      <TfIcon name="search" />
      <input
        v-model="q"
        class="input"
        type="search"
        placeholder="프로젝트 이름 · 키 검색"
        aria-label="프로젝트 검색"
      />
    </div>
    <div class="seg" role="group" aria-label="프로젝트 필터">
      <button
        v-for="s in segments"
        :key="s.value"
        type="button"
        :class="{ 'is-active': filter === s.value }"
        :aria-pressed="filter === s.value"
        @click="filter = s.value"
      >
        {{ s.label }}
      </button>
    </div>
    <span class="spacer" />
    <span v-if="session.isSysAdmin" class="text-sm text-muted"
      >템플릿은 목록에 나오지 않습니다 ·
      <RouterLink to="/admin/templates">시스템 › 템플릿</RouterLink></span
    >
  </div>

  <div v-if="loading && cards.length === 0" class="project-grid">
    <div v-for="n in 3" :key="n" class="card project-card"><TfSkeleton :lines="3" /></div>
  </div>
  <div v-else-if="visible.length" class="project-grid mb-6">
    <RouterLink
      v-for="p in visible"
      :key="p.key"
      :class="['card', 'project-card', { 'is-disabled': p.status === 'ARCHIVED' }]"
      :to="`/projects/${p.key}`"
    >
      <div class="row">
        <span class="project-key">{{ p.key }}</span>
        <span class="project-card-title">{{ p.nm }}</span>
        <span class="spacer" />
        <TfBadge v-if="p.status === 'ARCHIVED'" kind="draft">보관됨</TfBadge>
        <TfBadge v-if="p.isMember" :kind="p.myRole === 'VIEWER' ? 'outline' : 'accent'">{{
          ROLE_LABEL[p.myRole]
        }}</TfBadge>
        <TfBadge v-else kind="purple">시스템 관리자</TfBadge>
      </div>
      <div v-if="p.description" class="text-2">{{ p.description }}</div>
      <div class="row wrap">
        <span
          v-for="b in p.bizAreas"
          :key="b.bizCd"
          :class="['badge', 'mono', b.useYn ? 'badge-outline' : 'badge-gray']"
          :title="`${b.bizNm}${b.useYn ? '' : ' (사용 중지)'}`"
          >{{ b.bizCd }}{{ b.tableCnt ? ` ${b.tableCnt}` : '' }}</span
        >
        <span v-if="p.bizAreas.length === 0" class="text-sm text-muted">업무구분 없음</span>
      </div>
      <div class="project-meta">
        <span><TfIcon name="table" size="sm" /> 테이블 {{ p.tableCnt }}</span>
        <span><TfIcon name="users" size="sm" /> 멤버 {{ p.memberCnt }}</span>
        <span
          ><TfIcon name="clock" size="sm" /> {{ shortDateTime(p.lastChangedAt) }}
          {{ p.lastChangedBy ?? '' }}</span
        >
        <span>{{ dialectLabel(p.defaultDialect) }}</span>
      </div>
    </RouterLink>
    <RouterLink v-if="session.isSysAdmin" class="card project-card is-new" to="/projects/new">
      <div class="row">
        <TfIcon name="plus" size="lg" class="text-muted" /><span class="project-card-title"
          >새 프로젝트</span
        >
      </div>
      <div class="text-2">
        이름·키 → 표준 가져오기(템플릿 또는 다른 프로젝트) → 멤버, 한 페이지 3단계
      </div>
    </RouterLink>
  </div>
  <EmptyState
    v-else
    icon="folder"
    :title="filter === 'archived' ? '보관된 프로젝트가 없습니다' : '참여 중인 프로젝트가 없습니다'"
    :desc="
      session.isSysAdmin
        ? '새 프로젝트를 만들어 기본 표준을 가져올 수 있습니다.'
        : '시스템 관리자에게 프로젝트 멤버 추가를 요청하세요.'
    "
  >
    <RouterLink v-if="session.isSysAdmin" class="btn btn-primary btn-sm" to="/projects/new"
      ><TfIcon name="plus" />새 프로젝트</RouterLink
    >
  </EmptyState>
</template>
