<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { APP_NAME, MEMBER_ROLE_RANK, type MyProject } from '@termflow/shared';
import { useSessionStore } from '../../stores/session.js';
import TfIcon from '../ui/TfIcon.vue';
import TfPopover from '../ui/TfPopover.vue';
import { NAV_GROUPS, type NavItem } from './nav.js';
import { ROLE_LABEL } from './labels.js';

/**
 * 사이드바(§10.2, 목업 공통 골격): 브랜드 · 프로젝트 전환 셀렉터 · 그룹 메뉴(역할별 노출) · 하단 버전.
 * 레일(56px)은 상위 `.app.is-rail`이 결정한다(편집기 기본, 상단 바 버튼으로 전환).
 */
const session = useSessionStore();
const route = useRoute();

const currentKey = computed(() => (route.params['projectKey'] as string | undefined) ?? null);
const current = computed<MyProject | null>(
  () => session.projects.find((p) => p.key === currentKey.value) ?? null,
);
const switchable = computed(() => session.projects.filter((p) => p.kind === 'PROJECT'));

/** 템플릿 편집 중이면 [설계] 그룹을 숨긴다(§10.2: 템플릿에는 테이블이 없다). */
const isTemplate = computed(() => current.value?.kind === 'TEMPLATE');
/**
 * 프로젝트 전환 시 같은 하위 경로 유지(§10.2, 예: 업무구분 → 다른 프로젝트의 업무구분).
 * 하위 경로가 없는 화면(단계 이후 추가될 상세 ID 경로 등)은 첫 조각까지만 유지한다.
 */
function switchTarget(key: string): string {
  const cur = currentKey.value;
  if (!cur) return `/projects/${key}`;
  const rest = route.path.slice(`/projects/${cur}`.length);
  const first = rest.split('/').filter(Boolean)[0];
  return first ? `/projects/${key}/${first}` : `/projects/${key}`;
}

const groups = computed(() =>
  NAV_GROUPS.filter((g) =>
    g.scope === 'system'
      ? session.isSysAdmin
      : current.value !== null && !(g.id === 'design' && isTemplate.value),
  )
    .map((g) => ({
      ...g,
      items: g.items.filter(
        (i) =>
          !i.minRole ||
          (current.value && MEMBER_ROLE_RANK[current.value.role] >= MEMBER_ROLE_RANK[i.minRole]),
      ),
    }))
    .filter((g) => g.items.length > 0),
);

function target(i: NavItem): string | null {
  if (i.pending) return null;
  if (i.to) return i.to;
  if (i.projectPath !== undefined && current.value)
    return `/projects/${current.value.key}${i.projectPath}`;
  return null;
}
function isActive(i: NavItem): boolean {
  const t = target(i);
  if (!t) return false;
  return i.projectPath === ''
    ? route.path === t
    : route.path === t || route.path.startsWith(`${t}/`);
}
const version = __APP_VERSION__;
</script>

<template>
  <aside class="sidebar">
    <RouterLink class="brand" to="/projects">
      <span class="brand-mark">TF</span><span class="brand-name">{{ APP_NAME }}</span>
    </RouterLink>
    <div class="project-switcher">
      <TfPopover>
        <template #trigger="{ toggle, open, menuId }">
          <button
            class="project-switcher-btn"
            type="button"
            title="프로젝트 전환"
            aria-haspopup="menu"
            :aria-expanded="open"
            :aria-controls="menuId"
            @click="toggle"
          >
            <span v-if="current" class="project-key">{{ current.key }}</span>
            <span class="project-name">{{ current?.nm ?? '프로젝트 선택' }}</span>
            <TfIcon name="chevron-down" />
          </button>
        </template>
        <template #default="{ close }">
          <div class="dropdown-label">프로젝트 전환</div>
          <RouterLink
            v-for="p in switchable"
            :key="p.key"
            :class="['dropdown-item', { 'is-active': p.key === currentKey }]"
            :to="switchTarget(p.key)"
            role="menuitem"
            @click="close()"
          >
            <span class="project-key">{{ p.key }}</span
            >{{ p.nm }}
            <span class="dropdown-meta">{{ ROLE_LABEL[p.role] }}</span>
          </RouterLink>
          <div v-if="switchable.length === 0" class="dropdown-item is-disabled">
            소속 프로젝트 없음
          </div>
          <div class="dropdown-sep" />
          <RouterLink class="dropdown-item" to="/projects" role="menuitem" @click="close()">
            <TfIcon name="folder" />모든 프로젝트
          </RouterLink>
        </template>
      </TfPopover>
    </div>
    <nav class="nav" aria-label="주 메뉴">
      <div
        v-for="g in groups"
        :key="g.id"
        :class="['nav-group', { 'nav-group-admin': g.id === 'system' }]"
      >
        <div class="nav-title">{{ g.title }}</div>
        <template v-for="i in g.items" :key="i.id">
          <RouterLink
            v-if="target(i)"
            :to="target(i)!"
            :class="['nav-item', { 'is-active': isActive(i) }]"
            :aria-current="isActive(i) ? 'page' : undefined"
            :title="i.label"
          >
            <TfIcon :name="i.icon" /><span>{{ i.label }}</span>
          </RouterLink>
          <span
            v-else
            class="nav-item is-muted"
            aria-disabled="true"
            :title="`${i.label} (준비 중)`"
          >
            <TfIcon :name="i.icon" /><span>{{ i.label }}</span>
          </span>
        </template>
      </div>
    </nav>
    <div class="sidebar-footer">
      <span class="version">{{ APP_NAME }} v{{ version }}</span>
    </div>
  </aside>
</template>
