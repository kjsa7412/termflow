<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { SearchResponse } from '@termflow/shared';
import { standardsApi } from '../../api/standards.js';
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
const projectKey = computed(() => String(route.params['projectKey'] ?? ''));

// ── 전역 검색(T6.10·T7.9, §10.2: 현재 프로젝트 범위, 용어·도메인·테이블 각 5건) ──────────
const std = standardsApi();
const q = ref('');
const result = ref<SearchResponse | null>(null);
const searchOpen = ref(false);
const active = ref(0);
const input = ref<HTMLInputElement | null>(null);
let timer: ReturnType<typeof setTimeout> | null = null;
let ctrl: AbortController | null = null;
interface Hit {
  id: string;
  label: string;
  sub: string;
  to: string;
  group: string;
}
const hits = computed<Hit[]>(() => {
  const r = result.value;
  if (!r) return [];
  const base = `/projects/${projectKey.value}/standards`;
  return [
    ...r.terms.map((t) => ({
      id: `t${t.termId}`,
      label: t.termKor,
      sub: `${t.termPhysical ?? '—'}${t.status === 'APPROVED' ? '' : ` · ${t.status === 'PENDING' ? '검토대기' : '반려'}`}`,
      to: `${base}/terms?q=${encodeURIComponent(t.termKor)}`,
      group: '용어',
    })),
    ...r.domains.map((d) => ({
      id: `d${d.domainId}`,
      label: d.logicalNm,
      sub: `${d.physicalNm ?? '물리명 없음'} · ${d.typeText ?? '타입 없음'}${d.reviewYn ? ' · 검토필요' : ''}`,
      to: `${base}/domains?q=${encodeURIComponent(d.logicalNm)}`,
      group: '도메인',
    })),
    ...r.tables.map((t) => ({
      id: `tb${t.tableId}`,
      label: t.tableNm,
      sub: `${t.logicalNm} · ${t.bizCd}`,
      to: `/projects/${projectKey.value}/tables?q=${encodeURIComponent(t.tableNm)}`,
      group: '테이블',
    })),
  ];
});
watch(q, (v) => {
  if (timer) clearTimeout(timer);
  if (!v.trim() || !inProject.value) {
    result.value = null;
    return;
  }
  timer = setTimeout(async () => {
    ctrl?.abort();
    ctrl = new AbortController();
    try {
      result.value = await std.search(projectKey.value, v.trim(), ctrl.signal);
      active.value = 0;
      searchOpen.value = true;
    } catch {
      /* 취소·오류는 결과 없음으로 둔다 */
    }
  }, 200);
});
watch(projectKey, () => {
  q.value = '';
  result.value = null;
});
function go(h: Hit | undefined): void {
  if (!h) return;
  searchOpen.value = false;
  q.value = '';
  void router.push(h.to);
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    searchOpen.value = true;
    active.value = Math.min(hits.value.length - 1, active.value + 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    active.value = Math.max(0, active.value - 1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    go(hits.value[active.value]);
  } else if (e.key === 'Escape') {
    searchOpen.value = false;
  }
}
/** `/` 키로 검색창 포커스(입력 중이 아닐 때). */
function onGlobalKey(e: KeyboardEvent): void {
  const t = e.target as HTMLElement | null;
  if (e.key !== '/' || !inProject.value) return;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  e.preventDefault();
  input.value?.focus();
}
onMounted(() => document.addEventListener('keydown', onGlobalKey));
onBeforeUnmount(() => document.removeEventListener('keydown', onGlobalKey));
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
        ref="input"
        v-model="q"
        class="input"
        type="search"
        role="combobox"
        :aria-expanded="searchOpen && hits.length > 0"
        aria-controls="global-search-list"
        aria-autocomplete="list"
        :disabled="!inProject"
        :placeholder="
          inProject
            ? '이 프로젝트에서 용어 · 도메인 검색'
            : '프로젝트를 선택하면 검색할 수 있습니다'
        "
        aria-label="전역 검색(현재 프로젝트 범위)"
        @keydown="onKey"
        @focus="searchOpen = hits.length > 0"
        @blur="searchOpen = false"
      />
      <div
        v-if="searchOpen && result"
        id="global-search-list"
        class="search-pop"
        role="listbox"
        aria-label="검색 결과"
        data-testid="search-results"
      >
        <template v-if="hits.length">
          <template v-for="(h, i) in hits" :key="h.id">
            <div v-if="i === 0 || hits[i - 1]!.group !== h.group" class="dropdown-label">
              {{ h.group }}
            </div>
            <button
              type="button"
              role="option"
              :aria-selected="i === active"
              :class="['dropdown-item', { 'is-active': i === active }]"
              @mousedown.prevent="go(h)"
            >
              <span>{{ h.label }}</span>
              <span class="dropdown-meta mono">{{ h.sub }}</span>
            </button>
          </template>
        </template>
        <div v-else class="dropdown-item is-disabled">'{{ q }}' 결과 없음</div>
      </div>
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
