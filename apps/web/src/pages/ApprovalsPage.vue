<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { validateTermFields, type ApprovalItem, type ApprovalPage } from '@termflow/shared';
import { standardsApi } from '../api/standards.js';
import FilterSeg from '../components/std/FilterSeg.vue';
import ListPager from '../components/std/ListPager.vue';
import EmptyState from '../components/ui/EmptyState.vue';
import TfButton from '../components/ui/TfButton.vue';
import TfIcon from '../components/ui/TfIcon.vue';
import TfSkeleton from '../components/ui/TfSkeleton.vue';
import { errMsg, fmtNum, fmtTs, useProject } from '../composables/useProject.js';
import { useServerList } from '../composables/useServerList.js';
import { useToastStore } from '../stores/toast.js';

/**
 * 승인 큐(`/projects/{key}/standards/approvals`, 목업 11, §4.5): 검토대기 용어(등록 오래된 순)를 승인·정정 후 승인(물리약어·설명
 * 인라인 수정)·반려(사유 필수, 행 아래 입력 — 모달 없음, G9)·선택 승인. 물리약어 충돌(같은 약어의 다른 용어)은 경고 배지.
 * 프로젝트 관리자 화면(조회자는 목록만).
 */
const { key, project, canWrite } = useProject();
const api = standardsApi();
const toast = useToastStore();
const list = useServerList<ApprovalItem, ApprovalPage>({
  filters: ['state'],
  enabled: () => key.value !== '',
  fetch: (q) => api.approvals(key.value, q),
});
watch(key, () => void list.reload(), { immediate: true });
const page = computed(() => list.data.value);
const notFound = computed(() => (list.error.value as { status?: number } | null)?.status === 404);
const state = computed(() => (list.filters['state'] === 'PROCESSED' ? 'PROCESSED' : 'PENDING'));
const segs = computed(() => [
  { value: '', label: '검토대기', count: page.value?.counts.pending },
  { value: 'PROCESSED', label: '처리 완료', count: page.value?.counts.processed },
]);

interface Edit {
  termPhysical: string;
  description: string;
  rejecting: boolean;
  note: string;
}
const edits = reactive<Record<number, Edit>>({});
watch(
  () => page.value?.items,
  (items) => {
    for (const k of Object.keys(edits)) delete edits[Number(k)];
    for (const t of items ?? [])
      edits[t.termId] = {
        termPhysical: t.termPhysical ?? '',
        description: t.description ?? '',
        rejecting: false,
        note: '',
      };
  },
);
const changed = (t: ApprovalItem) => {
  const e = edits[t.termId];
  return (
    !!e && (e.termPhysical !== (t.termPhysical ?? '') || e.description !== (t.description ?? ''))
  );
};
const physIssue = (t: ApprovalItem) => {
  const e = edits[t.termId];
  return e
    ? (validateTermFields(t.termKor, e.termPhysical.trim() || null)[0]?.message ?? null)
    : null;
};
const busy = ref(false);
const selected = ref<number[]>([]);
function toggle(id: number): void {
  selected.value = selected.value.includes(id)
    ? selected.value.filter((x) => x !== id)
    : [...selected.value, id];
}
const allSelected = computed(
  () =>
    (page.value?.items.length ?? 0) > 0 &&
    page.value!.items.every((t) => selected.value.includes(t.termId)),
);
function toggleAll(): void {
  selected.value = allSelected.value ? [] : (page.value?.items ?? []).map((t) => t.termId);
}

async function approve(t: ApprovalItem): Promise<void> {
  const e = edits[t.termId]!;
  busy.value = true;
  try {
    const r = await api.approve(
      key.value,
      t.termId,
      changed(t)
        ? { termPhysical: e.termPhysical.trim(), description: e.description.trim() || null }
        : {},
    );
    toast.success(
      `'${t.termKor}' ${changed(t) ? `→ ${r.term.termPhysical}로 정정 후 ` : ''}승인했습니다`,
    );
    selected.value = selected.value.filter((x) => x !== t.termId);
    await list.reload();
  } catch (err) {
    toast.error(errMsg(err, '승인하지 못했습니다'));
  } finally {
    busy.value = false;
  }
}
async function reject(t: ApprovalItem): Promise<void> {
  const e = edits[t.termId]!;
  if (!e.note.trim()) return;
  busy.value = true;
  try {
    await api.reject(key.value, t.termId, e.note.trim());
    toast.info(`'${t.termKor}' 반려했습니다 · 이 용어를 쓴 컬럼에 경고가 표시됩니다`);
    await list.reload();
  } catch (err) {
    toast.error(errMsg(err, '반려하지 못했습니다'));
  } finally {
    busy.value = false;
  }
}
async function approveSelected(ids: number[]): Promise<void> {
  if (!ids.length) return;
  busy.value = true;
  try {
    const r = await api.approveBatch(key.value, ids);
    toast.success(`${r.approved}건을 승인했습니다`);
    selected.value = [];
    await list.reload();
  } catch (err) {
    toast.error(errMsg(err, '일괄 승인하지 못했습니다'));
  } finally {
    busy.value = false;
  }
}
const noConflict = computed(() =>
  (page.value?.items ?? []).filter((t) => t.physicalConflicts.length === 0).map((t) => t.termId),
);
const STATUS = {
  APPROVED: { cls: 'badge-approved', label: '승인' },
  REJECTED: { cls: 'badge-rejected', label: '반려' },
  PENDING: { cls: 'badge-pending', label: '검토대기' },
} as const;
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
          ><span>›</span><span>표준 사전</span><span>›</span><span>승인 큐</span>
        </div>
        <h1 class="page-title">
          승인 큐 <span class="count-pill info">{{ fmtNum(page?.counts.pending) }}</span>
        </h1>
        <p class="page-desc">
          편집자가 편집기에서 인라인 등록한 용어(검토대기)입니다. 검토대기 용어는 이미 자동완성에
          쓰이고 있으므로, <strong>정정</strong>하면 이 용어를 쓴 컬럼에 '표준이 바뀌었습니다'
          경고가, <strong>반려</strong>하면 '반려된 용어' 경고가 표시됩니다. 이 프로젝트({{
            key
          }})의 큐이며 승인된 용어는 이 프로젝트의 표준 사전에만 반영됩니다.
        </p>
      </div>
      <div v-if="canWrite && state === 'PENDING'" class="page-actions">
        <TfButton
          variant="secondary"
          icon="check"
          :disabled="noConflict.length === 0"
          :loading="busy"
          @click="approveSelected(noConflict)"
          >충돌 없는 항목 일괄 승인 ({{ noConflict.length }})</TfButton
        >
      </div>
    </div>

    <div class="toolbar">
      <FilterSeg
        :model-value="list.filters['state'] ?? ''"
        :options="segs"
        label="상태 필터"
        @change="(v: string) => list.setFilter('state', v)"
      />
      <span class="spacer" />
      <span class="text-sm text-muted">{{
        state === 'PENDING' ? '정렬: 등록 오래된 순' : '정렬: 최근 처리 순'
      }}</span>
    </div>

    <div
      v-if="canWrite && state === 'PENDING' && selected.length"
      class="bulk-bar is-visible"
      data-testid="bulk-bar"
    >
      <span
        ><strong>{{ selected.length }}</strong
        >건 선택</span
      >
      <TfButton
        variant="ghost"
        size="sm"
        icon="check"
        :loading="busy"
        @click="approveSelected(selected)"
        >선택 승인</TfButton
      >
      <TfButton variant="ghost" size="sm" @click="selected = []">선택 해제</TfButton>
    </div>

    <TfSkeleton v-if="list.loading.value && !page" :lines="4" />
    <div v-else class="table-wrap">
      <table class="table">
        <caption class="sr-only">
          승인 큐
        </caption>
        <thead>
          <tr>
            <th v-if="canWrite && state === 'PENDING'" class="col-check">
              <label class="check"
                ><input
                  type="checkbox"
                  :checked="allSelected"
                  aria-label="전체 선택"
                  @change="toggleAll" /><span class="check-box"
              /></label>
            </th>
            <th>한글 용어</th>
            <th>물리약어</th>
            <th>설명</th>
            <th>등록자 · 출처</th>
            <th>{{ state === 'PENDING' ? '검사' : '결과' }}</th>
            <th class="nowrap">{{ state === 'PENDING' ? '처리' : '처리자' }}</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="t in page?.items ?? []" :key="t.termId">
            <tr :class="{ 'is-editing': edits[t.termId]?.rejecting || changed(t) }">
              <td v-if="canWrite && state === 'PENDING'" class="col-check">
                <label class="check"
                  ><input
                    type="checkbox"
                    :checked="selected.includes(t.termId)"
                    :aria-label="`${t.termKor} 선택`"
                    @change="toggle(t.termId)" /><span class="check-box"
                /></label>
              </td>
              <td class="fw-600">{{ t.termKor }}</td>
              <td>
                <input
                  v-if="canWrite && state === 'PENDING' && edits[t.termId]"
                  v-model="edits[t.termId]!.termPhysical"
                  :class="[
                    'input',
                    'mono',
                    'w-120',
                    { 'is-invalid': !!physIssue(t) || t.physicalConflicts.length > 0 },
                  ]"
                  :aria-label="`${t.termKor} 물리약어 정정`"
                  @input="
                    edits[t.termId]!.termPhysical = edits[t.termId]!.termPhysical.toUpperCase()
                  "
                />
                <span v-else class="mono">{{ t.termPhysical }}</span>
              </td>
              <td>
                <input
                  v-if="canWrite && state === 'PENDING' && edits[t.termId]"
                  v-model="edits[t.termId]!.description"
                  class="input"
                  :aria-label="`${t.termKor} 설명`"
                  placeholder="(설명 없음)"
                />
                <span v-else :class="t.description ? 'text-2' : 'text-muted'">{{
                  t.description ?? '—'
                }}</span>
              </td>
              <td>
                {{ t.createdBy }} · {{ fmtTs(t.createdAt) }}
                <span v-if="t.columnSamples.length" class="d-block text-sm text-muted"
                  ><span v-for="(c, i) in t.columnSamples" :key="i"
                    >{{ i ? ', ' : '' }}<span class="mono">{{ c.tableNm }}</span> ·
                    {{ c.logicalNm }}</span
                  ><template v-if="t.columnCnt > t.columnSamples.length">
                    외 {{ t.columnCnt - t.columnSamples.length }}</template
                  ></span
                >
              </td>
              <td>
                <template v-if="state === 'PENDING'">
                  <span v-if="t.physicalConflicts.length" class="badge badge-warn"
                    ><TfIcon name="alert-triangle" />물리약어 충돌</span
                  >
                  <span v-else class="badge badge-approved"><TfIcon name="check" />충돌 없음</span>
                  <span v-if="t.physicalConflicts.length" class="d-block text-sm text-muted"
                    >'{{ t.physicalConflicts.map((c) => c.termKor).join(', ') }}'({{
                      t.termPhysical
                    }})와 공유</span
                  >
                </template>
                <template v-else>
                  <span :class="['badge', STATUS[t.status].cls]">{{ STATUS[t.status].label }}</span>
                  <span
                    v-if="t.status === 'REJECTED' && t.reviewNote"
                    class="d-block text-sm text-muted"
                    >사유: {{ t.reviewNote }}</span
                  >
                </template>
              </td>
              <td class="nowrap">
                <template v-if="state === 'PENDING' && canWrite">
                  <TfButton
                    variant="primary"
                    size="sm"
                    :disabled="!!physIssue(t)"
                    :loading="busy"
                    @click="approve(t)"
                    >{{ changed(t) ? '정정 후 승인' : '승인' }}</TfButton
                  >
                  {{ ' '
                  }}<TfButton
                    variant="danger-ghost"
                    size="sm"
                    @click="edits[t.termId]!.rejecting = !edits[t.termId]!.rejecting"
                    >반려</TfButton
                  >
                </template>
                <span v-else-if="state === 'PROCESSED'" class="text-muted"
                  >{{ t.reviewedBy }} · {{ fmtTs(t.reviewedAt) }}</span
                >
              </td>
            </tr>
            <tr
              v-if="state === 'PENDING' && (edits[t.termId]?.rejecting || physIssue(t))"
              class="row-msg"
            >
              <td :colspan="7">
                <div class="stack-sm">
                  <span v-if="physIssue(t)" class="text-sm text-danger"
                    ><TfIcon name="alert-circle" size="sm" /> {{ physIssue(t) }}</span
                  >
                  <div
                    v-if="edits[t.termId]?.rejecting"
                    class="row"
                    @keydown.enter.prevent="reject(t)"
                  >
                    <input
                      v-model="edits[t.termId]!.note"
                      class="input w-320"
                      placeholder="반려 사유 (등록자에게 표시, 필수)"
                      :aria-label="`${t.termKor} 반려 사유`"
                    />
                    <TfButton
                      variant="danger"
                      size="sm"
                      :disabled="!edits[t.termId]!.note.trim()"
                      :loading="busy"
                      @click="reject(t)"
                      >반려 확정</TfButton
                    >
                  </div>
                </div>
              </td>
            </tr>
          </template>
          <tr v-if="page && page.items.length === 0">
            <td colspan="7">
              <EmptyState
                in-table
                icon="check-circle"
                :title="state === 'PENDING' ? '검토대기 용어가 없습니다' : '처리한 용어가 없습니다'"
                desc="편집자가 편집기에서 미등록 용어를 인라인 등록하면 여기에 쌓입니다."
              />
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
  </template>
</template>
