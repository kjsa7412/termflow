<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import {
  MEMBER_ROLE_RANK,
  type BizAreaItem,
  type TableListItem,
  type TablePage,
} from '@termflow/shared';
import ConfirmDeleteModal from '../components/ui/ConfirmDeleteModal.vue';
import { projectsApi } from '../api/projects.js';
import { tablesApi } from '../api/tables.js';
import FilterSeg from '../components/std/FilterSeg.vue';
import ListPager from '../components/std/ListPager.vue';
import SearchBox from '../components/std/SearchBox.vue';
import EmptyState from '../components/ui/EmptyState.vue';
import TfBadge from '../components/ui/TfBadge.vue';
import TfButton from '../components/ui/TfButton.vue';
import TfIcon from '../components/ui/TfIcon.vue';
import TfPopover from '../components/ui/TfPopover.vue';
import TfSkeleton from '../components/ui/TfSkeleton.vue';
import { errMsg, fmtNum, fmtTs, useProject } from '../composables/useProject.js';
import { useServerList } from '../composables/useServerList.js';
import { useToastStore } from '../stores/toast.js';

/**
 * 테이블 목록(`/projects/{key}/tables`, 목업 09, §10.1, T7.12): 좌측 업무구분 목록(건수·'전체') + 우측 표(검색·상태·정렬·페이지).
 * 체크 선택 → [DDL 내보내기](선택 순서 = 목록 순서)로 이동(S3 다중: 전체 선택 → 내보내기 → 다운로드 = 클릭 3 / 이동 1).
 * 행 물리명 → 편집기(단계 8, 목업 09). 행 메뉴: DDL 미리보기 · 편집/열기 · 복제(같은 프로젝트 `_COPY`) · 삭제(확인 모달,
 * DRAFT 편집자·FINAL 프로젝트 관리자). [새 테이블]은 선택된 업무구분으로 시작(§10.1).
 * 검증 열은 서버 재검증(§5.7, DDL 생성과 같은 규칙) 결과다.
 */
const { key, project, session } = useProject();
const router = useRouter();
const tapi = tablesApi();
const papi = projectsApi();
const toast = useToastStore();
const list = useServerList<TableListItem, TablePage>({
  filters: ['bizAreaId', 'status'],
  defaultSize: 50,
  enabled: () => key.value !== '',
  fetch: (q, signal) => tapi.tables(key.value, q, signal),
});
const bizAreas = ref<BizAreaItem[]>([]);
/** 선택(페이지를 넘겨도 유지, 순서 = 선택한 순서). */
const selected = ref<number[]>([]);
async function loadBiz(): Promise<void> {
  try {
    bizAreas.value = await papi.bizAreas(key.value);
  } catch {
    bizAreas.value = [];
  }
}
watch(
  key,
  () => {
    selected.value = [];
    void list.reload();
    void loadBiz();
  },
  { immediate: true },
);
const page = computed(() => list.data.value);
const notFound = computed(() => (list.error.value as { status?: number } | null)?.status === 404);
const bizFilter = computed(() => list.filters['bizAreaId'] ?? '');
const currentBiz = computed(
  () => bizAreas.value.find((b) => String(b.bizAreaId) === bizFilter.value) ?? null,
);
const bizCount = (id: number) =>
  page.value?.bizAreaCounts.find((c) => c.bizAreaId === id)?.cnt ?? 0;
function pickBiz(id: number | null): void {
  list.setFilter('bizAreaId', id === null ? '' : String(id));
}
const statusSegs = computed(() => {
  const c = page.value?.statusCounts;
  return [
    { value: '', label: '전체', count: c ? c.DRAFT + c.FINAL : undefined },
    { value: 'DRAFT', label: 'DRAFT', count: c?.DRAFT },
    { value: 'FINAL', label: 'FINAL', count: c?.FINAL },
  ];
});
const SORTS = [
  { value: '', label: '수정일 ↓' },
  { value: 'tableNm,asc', label: '물리명 ↑' },
  { value: 'logicalNm,asc', label: '논리명 ↑' },
  { value: 'colCnt,desc', label: '컬럼 수 ↓' },
];
const sortValue = computed({
  get: () => (list.sort.value ? `${list.sort.value.key},${list.sort.value.dir}` : ''),
  set: (v: string) => {
    const [k, d] = v.split(',');
    list.sort.value = k ? { key: k, dir: d === 'desc' ? 'desc' : 'asc' } : null;
  },
});

// ── 선택 ────────────────────────────────────────────────────────────────
const items = computed(() => page.value?.items ?? []);
const pageIds = computed(() => items.value.map((t) => t.tableId));
const allOnPage = computed(
  () => pageIds.value.length > 0 && pageIds.value.every((id) => selected.value.includes(id)),
);
function toggleAll(): void {
  selected.value = allOnPage.value
    ? selected.value.filter((id) => !pageIds.value.includes(id))
    : [...selected.value, ...pageIds.value.filter((id) => !selected.value.includes(id))];
}
function toggle(id: number): void {
  selected.value = selected.value.includes(id)
    ? selected.value.filter((x) => x !== id)
    : [...selected.value, id];
}
const moreThanPage = computed(
  () => allOnPage.value && (page.value?.total ?? 0) > selected.value.length,
);
const selectingAll = ref(false);
/** 필터 결과 전체 선택(1회 200 상한 = 내보내기 상한, §6.10). */
async function selectFiltered(): Promise<void> {
  selectingAll.value = true;
  try {
    const q = { ...list.query(), page: 1, size: 200 };
    const r = await tapi.tables(key.value, q);
    selected.value = r.items.map((t) => t.tableId);
  } catch (e) {
    toast.error(errMsg(e, '전체 선택하지 못했습니다'));
  } finally {
    selectingAll.value = false;
  }
}
function exportSelected(): void {
  void router.push({
    path: `/projects/${key.value}/export`,
    query: { tableIds: selected.value.join(',') },
  });
}
const exportAllLink = computed(() =>
  currentBiz.value
    ? { path: `/projects/${key.value}/export`, query: { bizAreaIds: bizFilter.value } }
    : { path: `/projects/${key.value}/export` },
);
const previewLink = (t: TableListItem) => ({
  path: `/projects/${key.value}/export`,
  query: { tableIds: String(t.tableId) },
});
// ── 편집·복제·삭제(단계 8, T8.14) ───────────────────────────────────
const role = computed(() => (session.isSysAdmin ? 'ADMIN' : (project.value?.role ?? 'VIEWER')));
const canEdit = computed(
  () =>
    MEMBER_ROLE_RANK[role.value] >= MEMBER_ROLE_RANK.EDITOR &&
    project.value?.status !== 'ARCHIVED' &&
    project.value?.kind !== 'TEMPLATE',
);
/** 삭제: DRAFT 편집자 · FINAL 프로젝트 관리자(§8.4). */
const canDelete = (t: TableListItem) =>
  canEdit.value && (t.status === 'DRAFT' || role.value === 'ADMIN');
const editorLink = (t: TableListItem) => `/projects/${key.value}/tables/${t.tableId}`;
const newTableLink = computed(() => ({
  path: `/projects/${key.value}/tables/new`,
  query: currentBiz.value ? { bizAreaId: String(currentBiz.value.bizAreaId) } : {},
}));
const cloning = ref<number | null>(null);
async function cloneTable(t: TableListItem): Promise<void> {
  cloning.value = t.tableId;
  try {
    const r = await tapi.clone(key.value, t.tableId);
    toast.success(`${r.tableNm}(으)로 복제했습니다`);
    await router.push(`/projects/${key.value}/tables/${r.tableId}`);
  } catch (e) {
    toast.error(errMsg(e, '복제하지 못했습니다'));
  } finally {
    cloning.value = null;
  }
}
const deleting = ref<TableListItem | null>(null);
const deleteBusy = ref(false);
async function confirmDelete(): Promise<void> {
  const t = deleting.value;
  if (!t) return;
  deleteBusy.value = true;
  try {
    await tapi.remove(key.value, t.tableId);
    toast.success(`${t.tableNm}을(를) 삭제했습니다`);
    selected.value = selected.value.filter((id) => id !== t.tableId);
    deleting.value = null;
    void list.reload();
  } catch (e) {
    toast.error(errMsg(e, '삭제하지 못했습니다'));
  } finally {
    deleteBusy.value = false;
  }
}

const issueTitle = (t: TableListItem) =>
  [
    ...t.issues.map((i) => `${i.code}: ${i.message}`),
    ...(t.warningCnt + t.errorCnt > t.issues.length ? ['…'] : []),
  ].join('\n');
const COLS = 9;
</script>

<template>
  <EmptyState v-if="notFound" icon="folder" title="프로젝트를 찾을 수 없습니다">
    <RouterLink class="btn btn-secondary" to="/projects">프로젝트 목록으로</RouterLink>
  </EmptyState>
  <template v-else>
    <div class="page-header">
      <div>
        <div class="breadcrumb">
          <RouterLink :to="`/projects/${key}`">{{ project?.nm ?? key }}</RouterLink
          ><span>›</span><span>테이블</span>
        </div>
        <h1 class="page-title">
          테이블 <span class="count-pill">{{ fmtNum(page?.allCnt) }}</span>
        </h1>
        <p class="page-desc">
          프로젝트 {{ project?.nm ?? key }} ·
          {{
            currentBiz ? `업무구분 ${currentBiz.bizCd} ${currentBiz.bizNm} 선택됨` : '전체 업무구분'
          }}
          · FINAL {{ fmtNum(page?.statusCounts.FINAL) }} · DRAFT
          {{ fmtNum(page?.statusCounts.DRAFT) }} · 물리명은 프로젝트 안에서 유일
        </p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn btn-secondary" :to="exportAllLink"
          ><TfIcon name="export" />DDL 내보내기</RouterLink
        >
        <RouterLink
          v-if="canEdit"
          class="btn btn-primary"
          :to="newTableLink"
          data-testid="new-table"
          ><TfIcon name="plus" />새 테이블{{
            currentBiz ? ` · ${currentBiz.bizCd}` : ''
          }}</RouterLink
        >
      </div>
    </div>

    <div class="split split-nav">
      <aside class="card card-flush" aria-label="업무구분">
        <div class="card-header">
          <div class="card-title"><TfIcon name="folder" />업무구분</div>
          <RouterLink
            class="btn btn-ghost btn-sm btn-icon"
            :to="`/projects/${key}/biz-areas`"
            title="업무구분 관리"
            aria-label="업무구분 관리"
            ><TfIcon name="settings"
          /></RouterLink>
        </div>
        <div class="tree card-pad" role="listbox" aria-label="업무구분 필터">
          <div
            :class="['tree-node', { 'is-active': bizFilter === '' }]"
            role="option"
            tabindex="0"
            :aria-selected="bizFilter === ''"
            @click="pickBiz(null)"
            @keydown.enter="pickBiz(null)"
          >
            <TfIcon name="list" size="sm" />전체<span class="tree-count">{{
              fmtNum(page?.allCnt)
            }}</span>
          </div>
          <div
            v-for="b in bizAreas"
            :key="b.bizAreaId"
            :class="[
              'tree-node',
              { 'is-active': bizFilter === String(b.bizAreaId), 'is-muted text-muted': !b.useYn },
            ]"
            role="option"
            tabindex="0"
            :aria-selected="bizFilter === String(b.bizAreaId)"
            :title="b.useYn ? undefined : '사용 중지'"
            @click="pickBiz(b.bizAreaId)"
            @keydown.enter="pickBiz(b.bizAreaId)"
          >
            <span class="tree-key">{{ b.bizCd }}</span
            >{{ b.bizNm
            }}<span class="tree-count">{{ b.useYn ? fmtNum(bizCount(b.bizAreaId)) : '중지' }}</span>
          </div>
        </div>
        <div v-if="currentBiz?.tablePrefix" class="table-footer">
          새 테이블은 업무구분 접두어(<span class="mono">{{ currentBiz.tablePrefix }}</span
          >)로 시작합니다
        </div>
      </aside>

      <div>
        <div class="toolbar">
          <SearchBox
            v-model="list.q.value"
            label="테이블 검색"
            placeholder="물리명 · 논리명 검색"
            width="w-240"
          />
          <FilterSeg
            :model-value="list.filters['status'] ?? ''"
            :options="statusSegs"
            label="상태 필터"
            @change="(v: string) => list.setFilter('status', v)"
          />
          <select v-model="sortValue" class="select w-160" aria-label="정렬">
            <option v-for="o in SORTS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </div>

        <div
          v-if="selected.length > 0"
          class="bulk-bar is-visible"
          role="region"
          aria-label="선택 작업"
        >
          <span
            ><strong data-testid="selected-count">{{ selected.length }}</strong
            >개 선택</span
          >
          <TfButton variant="primary" size="sm" icon="export" @click="exportSelected"
            >DDL 내보내기</TfButton
          >
          <TfButton
            v-if="moreThanPage"
            variant="ghost"
            size="sm"
            :loading="selectingAll"
            @click="selectFiltered"
            >조건에 맞는 {{ fmtNum(page?.total) }}개 모두 선택</TfButton
          >
          <TfButton variant="ghost" size="sm" @click="selected = []">선택 해제</TfButton>
          <span class="spacer" />
          <span class="text-sm">전체 선택 → 내보내기 → 다운로드 = 클릭 3 / 이동 1</span>
        </div>

        <div class="table-wrap">
          <table class="table">
            <caption class="sr-only">
              테이블 목록
            </caption>
            <thead>
              <tr>
                <th class="col-check">
                  <label class="check" title="이 페이지 전체 선택">
                    <input
                      type="checkbox"
                      :checked="allOnPage"
                      aria-label="전체 선택"
                      @change="toggleAll"
                    /><span class="check-box" aria-hidden="true" />
                  </label>
                </th>
                <th class="nowrap">물리명</th>
                <th class="nowrap">논리명</th>
                <th class="num nowrap">컬럼</th>
                <th class="col-status">상태</th>
                <th>검증</th>
                <th class="nowrap">수정자</th>
                <th>수정일</th>
                <th class="col-menu" />
              </tr>
            </thead>
            <tbody>
              <tr v-if="list.loading.value && !page">
                <td :colspan="COLS"><TfSkeleton :lines="5" /></td>
              </tr>
              <tr
                v-for="t in items"
                :key="t.tableId"
                :class="{ 'is-selected': selected.includes(t.tableId) }"
              >
                <td class="col-check">
                  <label class="check">
                    <input
                      type="checkbox"
                      :checked="selected.includes(t.tableId)"
                      :aria-label="`${t.tableNm} 선택`"
                      @change="toggle(t.tableId)"
                    /><span class="check-box" aria-hidden="true" />
                  </label>
                </td>
                <td class="mono cell-clip" :title="t.tableNm">
                  <RouterLink
                    class="cell-link"
                    :to="editorLink(t)"
                    :title="`${t.tableNm} 편집기 열기`"
                    >{{ t.tableNm }}</RouterLink
                  >
                </td>
                <td class="cell-clip" :title="t.logicalNm">{{ t.logicalNm }}</td>
                <td class="num">{{ t.colCnt }}</td>
                <td>
                  <TfBadge :kind="t.status === 'FINAL' ? 'final' : 'draft'">{{ t.status }}</TfBadge>
                </td>
                <td class="nowrap">
                  <TfBadge
                    v-if="t.errorCnt > 0"
                    kind="danger"
                    icon="alert-circle"
                    :title="issueTitle(t)"
                    >오류 {{ t.errorCnt }}</TfBadge
                  >
                  <TfBadge
                    v-if="t.warningCnt > 0"
                    kind="warning"
                    icon="alert-triangle"
                    :title="issueTitle(t)"
                    >{{
                      t.warningCnt === 1 && t.errorCnt === 0 && t.issues[0]?.code === 'W_PK_NONE'
                        ? 'PK 없음'
                        : `경고 ${t.warningCnt}`
                    }}</TfBadge
                  >
                  <TfBadge v-if="t.reviewYn" kind="gray" :title="t.reviewNote ?? ''">검토</TfBadge>
                  <span v-if="t.errorCnt + t.warningCnt === 0 && !t.reviewYn" class="text-muted"
                    >—</span
                  >
                </td>
                <td class="col-low" :title="t.updatedBy">{{ t.updatedBy }}</td>
                <td class="nowrap">{{ fmtTs(t.updatedAt) }}</td>
                <td class="col-menu">
                  <TfPopover align="right">
                    <template #trigger="{ toggle: open, open: isOpen, menuId }">
                      <button
                        class="btn btn-ghost btn-sm btn-icon"
                        type="button"
                        :aria-label="`${t.tableNm} 행 메뉴`"
                        aria-haspopup="menu"
                        :aria-expanded="isOpen"
                        :aria-controls="menuId"
                        @click="open"
                      >
                        <TfIcon name="more" />
                      </button>
                    </template>
                    <template #default="{ close }">
                      <RouterLink
                        class="dropdown-item"
                        role="menuitem"
                        :to="previewLink(t)"
                        @click="close()"
                        ><TfIcon name="export" />DDL 미리보기</RouterLink
                      >
                      <RouterLink
                        class="dropdown-item"
                        role="menuitem"
                        :to="editorLink(t)"
                        @click="close()"
                        ><TfIcon name="edit" />{{
                          canEdit && t.status === 'DRAFT' ? '편집' : '열기'
                        }}</RouterLink
                      >
                      <button
                        v-if="canEdit"
                        class="dropdown-item"
                        type="button"
                        role="menuitem"
                        :disabled="cloning === t.tableId"
                        @click="(close(), cloneTable(t))"
                      >
                        <TfIcon name="duplicate" />복제({{ t.tableNm }}_COPY)
                      </button>
                      <template v-if="canDelete(t)">
                        <div class="dropdown-sep" />
                        <button
                          class="dropdown-item is-danger"
                          type="button"
                          role="menuitem"
                          @click="(close(), (deleting = t))"
                        >
                          <TfIcon name="trash" />삭제
                        </button>
                      </template>
                    </template>
                  </TfPopover>
                </td>
              </tr>
              <tr v-if="page && items.length === 0">
                <td :colspan="COLS">
                  <EmptyState
                    v-if="list.q.value || list.filters['status']"
                    in-table
                    icon="search"
                    :title="`'${list.q.value || list.filters['status']}'에 해당하는 테이블이 없습니다`"
                    desc="물리명·논리명 일부로 검색합니다. 상태 필터가 적용되어 있는지 확인하세요."
                  >
                    <button
                      class="btn btn-secondary btn-sm"
                      type="button"
                      @click="((list.q.value = ''), list.setFilter('status', ''))"
                    >
                      <TfIcon name="x" />검색 지우기
                    </button>
                  </EmptyState>
                  <EmptyState
                    v-else
                    in-table
                    icon="table"
                    :title="
                      currentBiz
                        ? `업무구분 ${currentBiz.bizCd} ${currentBiz.bizNm}에는 아직 테이블이 없습니다`
                        : '아직 테이블이 없습니다'
                    "
                    desc="[새 테이블]로 첫 테이블을 설계하세요. 업무구분 접두어가 물리명 앞에 붙습니다."
                  >
                    <RouterLink v-if="canEdit" class="btn btn-primary btn-sm" :to="newTableLink"
                      ><TfIcon name="plus" />새 테이블</RouterLink
                    >
                  </EmptyState>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <ListPager
          v-model:page="list.page.value"
          v-model:size="list.size.value"
          :total="page?.total ?? 0"
        />
      </div>
    </div>
    <ConfirmDeleteModal
      :open="deleting !== null"
      :title="`테이블 ${deleting?.tableNm ?? ''} 삭제`"
      :busy="deleteBusy"
      @confirm="confirmDelete"
      @cancel="deleting = null"
    >
      <p>
        <strong>{{ deleting?.logicalNm }}</strong
        >({{ deleting?.status }}, 컬럼 {{ deleting?.colCnt }})과 컬럼·변경이력이 모두 삭제됩니다.
        되돌릴 수 없습니다.
      </p>
    </ConfirmDeleteModal>
  </template>
</template>
