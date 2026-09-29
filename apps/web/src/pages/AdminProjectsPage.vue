<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import type { AdminProjectItem, ProjectStatus } from '@termflow/shared';
import { ApiError } from '../api/client.js';
import { projectsApi } from '../api/projects.js';
import { shortDateTime } from '../components/layout/labels.js';
import ConfirmDeleteModal from '../components/ui/ConfirmDeleteModal.vue';
import EmptyState from '../components/ui/EmptyState.vue';
import TfBadge from '../components/ui/TfBadge.vue';
import TfIcon from '../components/ui/TfIcon.vue';
import TfPopover from '../components/ui/TfPopover.vue';
import { useSessionStore } from '../stores/session.js';
import { useToastStore } from '../stores/toast.js';

/**
 * 시스템 › 프로젝트(`/admin/projects`, 목업 없음 — 02 표 패턴, §4.7·§10.1): 전체 프로젝트(상태·업무구분·테이블·멤버),
 * [새 프로젝트] → 마법사, 보관·복원, 삭제(보관 상태에서만, 키 재입력).
 */
const api = projectsApi();
const toast = useToastStore();
const session = useSessionStore();
const items = ref<AdminProjectItem[]>([]);
const loading = ref(true);
const q = ref('');
const status = ref<ProjectStatus | 'ALL'>('ALL');

async function load(): Promise<void> {
  loading.value = true;
  try {
    items.value = await api.adminProjects({
      q: q.value.trim() || undefined,
      status: status.value === 'ALL' ? undefined : status.value,
    });
  } catch {
    toast.error('프로젝트 목록을 불러오지 못했습니다');
  } finally {
    loading.value = false;
  }
}
onMounted(load);
watch(status, load);
let t: ReturnType<typeof setTimeout> | undefined;
watch(q, () => {
  clearTimeout(t);
  t = setTimeout(() => void load(), 300);
});
const counts = computed(() => ({
  active: items.value.filter((p) => p.status === 'ACTIVE').length,
  archived: items.value.filter((p) => p.status === 'ARCHIVED').length,
}));

async function setStatus(p: AdminProjectItem, s: ProjectStatus): Promise<void> {
  try {
    await api.setProjectStatus(p.key, s);
    toast.success(
      s === 'ARCHIVED' ? `${p.key}을(를) 보관했습니다 — 읽기 전용` : `${p.key}을(를) 복원했습니다`,
    );
    await Promise.all([load(), session.refresh()]);
  } catch (e) {
    toast.error(
      e instanceof ApiError && e.problem?.detail ? e.problem.detail : '처리하지 못했습니다',
    );
  }
}
const deleting = ref<AdminProjectItem | null>(null);
const confirmKey = ref('');
const busy = ref(false);
async function remove(): Promise<void> {
  const p = deleting.value;
  if (!p) return;
  busy.value = true;
  try {
    await api.deleteProject(p.key, confirmKey.value);
    toast.success(`${p.key}을(를) 삭제했습니다`);
    deleting.value = null;
    await Promise.all([load(), session.refresh()]);
  } catch (e) {
    toast.error(
      e instanceof ApiError && e.problem?.detail ? e.problem.detail : '삭제하지 못했습니다',
    );
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="page-header">
    <div>
      <div class="breadcrumb"><span>시스템</span><span>›</span><span>프로젝트</span></div>
      <h1 class="page-title">
        프로젝트 <span class="count-pill">{{ items.length }}</span>
      </h1>
      <p class="page-desc">
        모든 프로젝트를 관리합니다(시스템 관리자). 보관하면 읽기 전용이 되고 목록에서 숨겨지며,
        가져오기 원본으로는 계속 쓸 수 있습니다. 삭제는 보관된 프로젝트만, 키를 다시 입력해
        확인합니다. 템플릿은 <RouterLink to="/admin/templates">시스템 › 템플릿</RouterLink>에서
        관리합니다.
      </p>
    </div>
    <div class="page-actions">
      <RouterLink class="btn btn-primary" to="/projects/new"
        ><TfIcon name="plus" />새 프로젝트</RouterLink
      >
    </div>
  </div>

  <div class="toolbar">
    <div class="input-wrap w-320">
      <TfIcon name="search" /><input
        v-model="q"
        class="input"
        type="search"
        placeholder="프로젝트 이름 · 키 검색"
        aria-label="프로젝트 검색"
      />
    </div>
    <div class="seg" role="group" aria-label="상태 필터">
      <button
        v-for="s in [
          { v: 'ALL', l: '전체' },
          { v: 'ACTIVE', l: '활성' },
          { v: 'ARCHIVED', l: '보관됨' },
        ] as const"
        :key="s.v"
        type="button"
        :class="{ 'is-active': status === s.v }"
        :aria-pressed="status === s.v"
        @click="status = s.v"
      >
        {{ s.l }}
        <span v-if="status === 'ALL' && s.v !== 'ALL'" class="count">{{
          s.v === 'ACTIVE' ? counts.active : counts.archived
        }}</span>
      </button>
    </div>
  </div>

  <div class="table-wrap">
    <table class="table">
      <caption class="sr-only">
        전체 프로젝트
      </caption>
      <thead>
        <tr>
          <th>키</th>
          <th>이름</th>
          <th>업무구분</th>
          <th class="num">테이블</th>
          <th class="num">멤버</th>
          <th>상태</th>
          <th>표준 원본</th>
          <th>최근 변경</th>
          <th class="col-menu" />
        </tr>
      </thead>
      <tbody>
        <tr v-for="p in items" :key="p.key" :class="{ 'is-disabled': p.status === 'ARCHIVED' }">
          <td>
            <span class="project-key">{{ p.key }}</span>
          </td>
          <td>
            <RouterLink class="cell-link" :to="`/projects/${p.key}`">{{ p.nm }}</RouterLink>
          </td>
          <td class="mono text-2">{{ p.bizCds.join(' ') || '—' }}</td>
          <td class="num">{{ p.tableCnt }}</td>
          <td class="num">{{ p.memberCnt }}</td>
          <td>
            <TfBadge :kind="p.status === 'ACTIVE' ? 'approved' : 'draft'">{{
              p.status === 'ACTIVE' ? '활성' : '보관됨'
            }}</TfBadge>
          </td>
          <td class="text-muted">{{ p.copiedFrom?.nm ?? '—' }}</td>
          <td class="text-muted">{{ shortDateTime(p.lastChangedAt) }}</td>
          <td class="col-menu">
            <TfPopover align="right">
              <template #trigger="{ toggle, open, menuId }">
                <button
                  class="btn btn-ghost btn-sm btn-icon"
                  type="button"
                  :aria-label="`${p.key} 행 메뉴`"
                  aria-haspopup="menu"
                  :aria-expanded="open"
                  :aria-controls="menuId"
                  @click="toggle"
                >
                  <TfIcon name="more" />
                </button>
              </template>
              <template #default="{ close }">
                <RouterLink
                  class="dropdown-item"
                  role="menuitem"
                  :to="`/projects/${p.key}/settings`"
                  @click="close()"
                  ><TfIcon name="settings" />설정</RouterLink
                >
                <button
                  v-if="p.status === 'ACTIVE'"
                  class="dropdown-item"
                  type="button"
                  role="menuitem"
                  @click="(close(), setStatus(p, 'ARCHIVED'))"
                >
                  <TfIcon name="lock" />보관
                </button>
                <button
                  v-else
                  class="dropdown-item"
                  type="button"
                  role="menuitem"
                  @click="(close(), setStatus(p, 'ACTIVE'))"
                >
                  <TfIcon name="unlock" />복원
                </button>
                <div class="dropdown-sep" />
                <button
                  class="dropdown-item is-danger"
                  type="button"
                  role="menuitem"
                  :disabled="p.status !== 'ARCHIVED'"
                  :title="p.status !== 'ARCHIVED' ? '보관된 프로젝트만 삭제할 수 있습니다' : ''"
                  @click="(close(), (deleting = p), (confirmKey = ''))"
                >
                  <TfIcon name="trash" />삭제{{ p.status !== 'ARCHIVED' ? ' (보관 후)' : '' }}
                </button>
              </template>
            </TfPopover>
          </td>
        </tr>
        <tr v-if="!loading && items.length === 0">
          <td colspan="9">
            <EmptyState in-table icon="database" title="조건에 맞는 프로젝트가 없습니다" />
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <ConfirmDeleteModal
    :open="deleting !== null"
    :title="`프로젝트 '${deleting?.nm}'을(를) 삭제할까요?`"
    :busy="busy"
    :confirm-disabled="confirmKey !== deleting?.key"
    @cancel="deleting = null"
    @confirm="remove"
  >
    테이블 {{ deleting?.tableCnt }}개와 업무구분·표준 사전·변경이력이 모두 삭제됩니다. 템플릿과 다른
    프로젝트에는 영향이 없습니다. 확인을 위해 키 <strong class="mono">{{ deleting?.key }}</strong
    >를 입력하세요.
    <input
      v-model="confirmKey"
      class="input mono mt-3 w-120"
      :placeholder="deleting?.key"
      aria-label="확인용 키"
    />
  </ConfirmDeleteModal>
</template>
