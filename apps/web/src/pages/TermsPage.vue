<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import {
  normalizeTermKor,
  validateTermFields,
  type TermCheckResponse,
  type TermItem,
  type TermPage,
  type TermRef,
} from '@termflow/shared';
import { saveBlob } from '../api/client.js';
import { standardsApi, type TermBody } from '../api/standards.js';
import AuditHistory from '../components/std/AuditHistory.vue';
import FilterSeg from '../components/std/FilterSeg.vue';
import ListPager from '../components/std/ListPager.vue';
import SearchBox from '../components/std/SearchBox.vue';
import ConfirmDeleteModal from '../components/ui/ConfirmDeleteModal.vue';
import EmptyState from '../components/ui/EmptyState.vue';
import TfButton from '../components/ui/TfButton.vue';
import TfIcon from '../components/ui/TfIcon.vue';
import TfPopover from '../components/ui/TfPopover.vue';
import TfSkeleton from '../components/ui/TfSkeleton.vue';
import { errMsg, fmtNum, fmtTs, useProject } from '../composables/useProject.js';
import { useServerList } from '../composables/useServerList.js';
import { useToastStore } from '../stores/toast.js';

/**
 * 용어(`/projects/{key}/standards/terms`, 목업 04, §4.5·§10.3): 검색·상태 칩·정렬·서버 페이지, 첫 행 인라인 등록(S1 단건:
 * 한글·물리약어 입력 → Enter), 행 인라인 편집(Enter 저장/Esc 취소), 물리약어 공유 경고(R8), 행 변경이력, [일괄 등록].
 * 쓰기 컨트롤은 프로젝트 관리자(시스템 관리자)에게만 보인다.
 */
const { key, project, canWrite, isAdmin } = useProject();
const api = standardsApi();
const toast = useToastStore();

const list = useServerList<TermItem, TermPage>({
  filters: ['status', 'shared'],
  enabled: () => key.value !== '',
  fetch: (q) => api.terms(key.value, q),
});
watch(key, () => void list.reload(), { immediate: true });
const page = computed(() => list.data.value);
const notFound = computed(() => (list.error.value as { status?: number } | null)?.status === 404);
const segs = computed(() => [
  { value: '', label: '전체', count: page.value?.counts.all },
  { value: 'APPROVED', label: '승인', count: page.value?.counts.approved },
  { value: 'PENDING', label: '검토대기', count: page.value?.counts.pending },
  { value: 'REJECTED', label: '반려', count: page.value?.counts.rejected },
]);
const SORTS = [
  { value: '', label: '한글 용어 ↑' },
  { value: 'termPhysical,asc', label: '물리약어 ↑' },
  { value: 'updatedAt,desc', label: '수정일 ↓' },
  { value: 'createdAt,desc', label: '등록일 ↓' },
];
const sortValue = computed({
  get: () => (list.sort.value ? `${list.sort.value.key},${list.sort.value.dir}` : ''),
  set: (v: string) => {
    const [k, d] = v.split(',');
    list.sort.value = k ? { key: k, dir: d === 'desc' ? 'desc' : 'asc' } : null;
  },
});
const sharedOnly = computed({
  get: () => list.filters['shared'] === 'true',
  set: (v: boolean) => list.setFilter('shared', v ? 'true' : ''),
});
const STATUS_BADGE = {
  APPROVED: { cls: 'badge-approved', label: '승인' },
  PENDING: { cls: 'badge-pending', label: '검토대기' },
  REJECTED: { cls: 'badge-rejected', label: '반려' },
} as const;

// ── 인라인 등록(첫 행) ─────────────────────────────────────────
const draft = reactive({ termKor: '', termPhysical: '', description: '', synonymRef: '' });
const check = ref<TermCheckResponse | null>(null);
const busy = ref(false);
const korInput = ref<HTMLInputElement | null>(null);
let checkTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => draft.termPhysical,
  (v) => {
    const up = v.toUpperCase();
    if (up !== v) draft.termPhysical = up;
  },
);
watch(
  () => [draft.termKor, draft.termPhysical],
  () => {
    if (checkTimer) clearTimeout(checkTimer);
    if (!draft.termKor.trim() && !draft.termPhysical.trim()) {
      check.value = null;
      return;
    }
    checkTimer = setTimeout(async () => {
      try {
        check.value = await api.checkTerm(key.value, {
          termKor: draft.termKor,
          termPhysical: draft.termPhysical,
        });
      } catch {
        check.value = null;
      }
    }, 250);
  },
);
const draftIssues = computed(() =>
  draft.termKor || draft.termPhysical
    ? validateTermFields(normalizeTermKor(draft.termKor), draft.termPhysical.trim() || null)
    : [],
);
const canAdd = computed(
  () => draftIssues.value.length === 0 && draft.termKor.trim() !== '' && !check.value?.korExists,
);
const sharedWith = (refs: TermRef[] | undefined) => (refs ?? []).map((r) => r.termKor).join(', ');
function bodyOf(d: typeof draft): TermBody {
  return {
    termKor: d.termKor,
    termPhysical: d.termPhysical.trim() || null,
    description: d.description.trim() || null,
    synonymRef: d.synonymRef.trim() || null,
  };
}
function clearDraft(): void {
  Object.assign(draft, { termKor: '', termPhysical: '', description: '', synonymRef: '' });
  check.value = null;
  korInput.value?.focus();
}
async function add(): Promise<void> {
  if (!canAdd.value || busy.value) return;
  busy.value = true;
  try {
    const r = await api.createTerm(key.value, bodyOf(draft));
    toast.success(
      `'${r.term.termKor} → ${r.term.termPhysical}' 등록했습니다${
        r.physicalConflicts.length ? ` · 물리약어 공유: ${sharedWith(r.physicalConflicts)}` : ''
      }`,
    );
    clearDraft();
    await list.reload();
  } catch (e) {
    toast.error(errMsg(e, '등록하지 못했습니다'));
  } finally {
    busy.value = false;
  }
}

// ── 행 편집·이력·삭제 ─────────────────────────────────────────
const editingId = ref<number | null>(null);
const edit = reactive({ termKor: '', termPhysical: '', description: '', synonymRef: '' });
const historyId = ref<number | null>(null);
function startEdit(t: TermItem): void {
  editingId.value = t.termId;
  Object.assign(edit, {
    termKor: t.termKor,
    termPhysical: t.termPhysical ?? '',
    description: t.description ?? '',
    synonymRef: t.synonymRef ?? '',
  });
}
async function saveEdit(t: TermItem): Promise<void> {
  busy.value = true;
  try {
    const r = await api.updateTerm(key.value, t.termId, {
      ...bodyOf(edit),
      termPhysical: edit.termPhysical.toUpperCase().trim() || null,
    });
    toast.success(`'${r.term.termKor}' 저장했습니다`);
    editingId.value = null;
    await list.reload();
  } catch (e) {
    toast.error(errMsg(e, '저장하지 못했습니다'));
  } finally {
    busy.value = false;
  }
}
const deleting = ref<{ t: TermItem; domainCnt: number } | null>(null);
async function askDelete(t: TermItem): Promise<void> {
  try {
    const d = await api.term(key.value, t.termId);
    deleting.value = { t, domainCnt: d.domainCnt };
  } catch (e) {
    toast.error(errMsg(e, '삭제 정보를 불러오지 못했습니다'));
  }
}
async function remove(): Promise<void> {
  if (!deleting.value) return;
  busy.value = true;
  try {
    await api.deleteTerm(key.value, deleting.value.t.termId);
    toast.success(`'${deleting.value.t.termKor}' 삭제했습니다`);
    deleting.value = null;
    await list.reload();
  } catch (e) {
    toast.error(errMsg(e, '삭제하지 못했습니다'));
  } finally {
    busy.value = false;
  }
}
async function downloadTemplate(): Promise<void> {
  try {
    const r = await api.importTemplate(key.value, 'terms');
    saveBlob(r.blob, r.fileName ?? '용어_일괄등록_템플릿.xlsx');
  } catch (e) {
    toast.error(errMsg(e, '템플릿을 내려받지 못했습니다'));
  }
}
function prefillFromSearch(): void {
  draft.termKor = list.q.value.trim();
  list.q.value = '';
  korInput.value?.focus();
}
const COLS = 7;
</script>

<template>
  <EmptyState
    v-if="notFound"
    icon="folder"
    title="프로젝트를 찾을 수 없습니다"
    desc="주소가 잘못되었거나 이 프로젝트의 멤버가 아닙니다."
  >
    <RouterLink class="btn btn-secondary" to="/projects">프로젝트 목록으로</RouterLink>
  </EmptyState>
  <template v-else>
    <div class="page-header">
      <div>
        <div class="breadcrumb">
          <RouterLink :to="`/projects/${key}`">{{ project?.nm ?? key }}</RouterLink
          ><span>›</span><span>표준 사전</span><span>›</span><span>용어</span>
        </div>
        <h1 class="page-title">
          용어 <span class="count-pill">{{ fmtNum(page?.counts.all) }}</span>
        </h1>
        <p class="page-desc">
          한글 용어 ↔ 물리약어 매핑. 자동완성(정확일치·유사·분절 조합)의 원천이며
          <strong>이 프로젝트({{ key }}) 전용 사본</strong>입니다(수정해도 다른 프로젝트·템플릿에
          영향 없음). 편집자가 편집기에서 등록한 용어는
          <span class="badge badge-pending">검토대기</span>로 즉시 자동완성에 쓰이고 프로젝트
          관리자가 승인 큐에서 처리합니다.
          {{ canWrite ? '' : '프로젝트 관리자만 편집할 수 있습니다.' }}
        </p>
      </div>
      <div class="page-actions">
        <TfButton variant="ghost" icon="file-text" @click="downloadTemplate"
          >템플릿 다운로드</TfButton
        >
        <RouterLink
          v-if="canWrite"
          class="btn btn-secondary"
          :to="`/projects/${key}/standards/terms/import`"
          ><TfIcon name="upload" />일괄 등록</RouterLink
        >
      </div>
    </div>

    <div class="toolbar">
      <SearchBox v-model="list.q.value" label="용어 검색" placeholder="한글 용어 · 물리약어 검색" />
      <FilterSeg
        :model-value="list.filters['status'] ?? ''"
        :options="segs"
        label="상태 필터"
        @change="(v: string) => list.setFilter('status', v)"
      />
      <select v-model="sortValue" class="select w-160" aria-label="정렬">
        <option v-for="o in SORTS" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
      <label class="check">
        <input v-model="sharedOnly" type="checkbox" /><span class="check-box" />물리약어 공유만
        <span class="text-muted">({{ fmtNum(page?.counts.shared) }})</span>
      </label>
    </div>

    <div class="table-wrap">
      <table class="table">
        <caption class="sr-only">
          용어 목록
        </caption>
        <thead>
          <tr>
            <th>한글 용어</th>
            <th>물리약어</th>
            <th>설명</th>
            <th>동의어 참조</th>
            <th class="col-status">상태</th>
            <th>등록 · 수정</th>
            <th class="col-menu" />
          </tr>
        </thead>
        <tbody>
          <template v-if="canWrite">
            <tr class="is-inline-new" @keydown.enter.prevent="add" @keydown.esc="clearDraft">
              <td>
                <input
                  ref="korInput"
                  v-model="draft.termKor"
                  :class="['input', { 'is-invalid': check?.korExists }]"
                  aria-label="한글 용어"
                  placeholder="한글 용어"
                  maxlength="100"
                />
              </td>
              <td>
                <input
                  v-model="draft.termPhysical"
                  :class="[
                    'input',
                    'mono',
                    'w-120',
                    {
                      'is-invalid':
                        draft.termPhysical !== '' &&
                        draftIssues.some((i) => i.field === 'termPhysical'),
                    },
                  ]"
                  aria-label="물리약어"
                  placeholder="RSCH"
                  maxlength="30"
                />
              </td>
              <td>
                <input
                  v-model="draft.description"
                  class="input"
                  aria-label="설명"
                  placeholder="설명 (선택)"
                />
              </td>
              <td>
                <input
                  v-model="draft.synonymRef"
                  class="input"
                  aria-label="동의어 참조"
                  placeholder="쉼표로 구분"
                />
              </td>
              <td><span class="badge badge-approved">승인으로 등록</span></td>
              <td colspan="2" class="nowrap">
                <TfButton
                  variant="primary"
                  size="sm"
                  kbd="Enter"
                  :disabled="!canAdd"
                  :loading="busy"
                  @click="add"
                  >등록</TfButton
                >
                {{ ' '
                }}<TfButton variant="ghost" size="sm" kbd="Esc" @click="clearDraft"
                  >지우기</TfButton
                >
              </td>
            </tr>
            <tr v-if="draft.termKor || draft.termPhysical" class="row-msg">
              <td :colspan="COLS">
                <div class="row wrap text-sm" data-testid="draft-msg">
                  <span v-if="check?.korExists" class="text-danger"
                    ><TfIcon name="alert-circle" size="sm" /> '{{ check.korTerm?.termKor }}'은(는)
                    이미 있습니다({{ check.korTerm?.termPhysical }})</span
                  >
                  <span v-else-if="check && draft.termKor.trim()" class="text-success"
                    ><TfIcon name="check" size="sm" /> '{{ draft.termKor.trim() }}' 중복 없음</span
                  >
                  <span
                    v-for="i in draftIssues.filter(
                      (x) => x.field === 'termPhysical' && draft.termPhysical,
                    )"
                    :key="i.code"
                    class="text-danger"
                    ><TfIcon name="alert-circle" size="sm" /> {{ i.message }}</span
                  >
                  <span
                    v-if="check && check.physicalUsedBy.length && !check.korExists"
                    class="text-warning"
                    ><TfIcon name="alert-triangle" size="sm" /> 물리약어
                    <span class="mono">{{ draft.termPhysical }}</span
                    >는 '{{ sharedWith(check.physicalUsedBy) }}'와 공유 중(허용, R8 경고)</span
                  >
                  <span class="text-muted">· 대문자·숫자·_ 만 허용 · 최대 30자</span>
                </div>
              </td>
            </tr>
          </template>

          <tr v-if="list.loading.value && !page">
            <td :colspan="COLS"><TfSkeleton :lines="5" /></td>
          </tr>
          <template v-for="t in page?.items ?? []" :key="t.termId">
            <tr
              v-if="editingId === t.termId"
              class="is-editing"
              @keydown.enter.prevent="saveEdit(t)"
              @keydown.esc="editingId = null"
            >
              <td><input v-model="edit.termKor" class="input" aria-label="한글 용어" /></td>
              <td>
                <input v-model="edit.termPhysical" class="input mono w-120" aria-label="물리약어" />
              </td>
              <td><input v-model="edit.description" class="input" aria-label="설명" /></td>
              <td><input v-model="edit.synonymRef" class="input" aria-label="동의어 참조" /></td>
              <td>
                <span :class="['badge', STATUS_BADGE[t.status].cls]">{{
                  STATUS_BADGE[t.status].label
                }}</span>
              </td>
              <td colspan="2" class="nowrap">
                <TfButton
                  variant="primary"
                  size="sm"
                  kbd="Enter"
                  :loading="busy"
                  @click="saveEdit(t)"
                  >저장</TfButton
                >
                {{ ' '
                }}<TfButton variant="ghost" size="sm" kbd="Esc" @click="editingId = null"
                  >취소</TfButton
                >
              </td>
            </tr>
            <tr v-else :class="{ 'is-disabled': t.status === 'REJECTED' }">
              <td>{{ t.termKor }}</td>
              <td class="mono">{{ t.termPhysical ?? '—' }}</td>
              <td :class="t.description ? 'text-2' : 'text-muted'">{{ t.description ?? '—' }}</td>
              <td :class="t.synonymRef || t.sharedCnt ? 'text-2' : 'text-muted'">
                {{ t.synonymRef ?? (t.sharedCnt ? '' : '—') }}
                <span v-if="t.sharedCnt" class="text-muted text-sm"
                  >(물리약어 공유 {{ t.sharedCnt }})</span
                >
              </td>
              <td>
                <span :class="['badge', STATUS_BADGE[t.status].cls]">{{
                  STATUS_BADGE[t.status].label
                }}</span>
              </td>
              <td class="text-muted">
                {{ t.updatedBy }} · {{ fmtTs(t.updatedAt).slice(0, 10) }}
                <template v-if="t.status === 'REJECTED' && t.reviewNote">
                  · 사유: {{ t.reviewNote }}</template
                >
              </td>
              <td class="col-menu">
                <RouterLink
                  v-if="t.status === 'PENDING' && isAdmin"
                  class="btn btn-ghost btn-sm"
                  :to="`/projects/${key}/standards/approvals`"
                  >승인 큐</RouterLink
                >
                <TfPopover v-else align="right">
                  <template #trigger="{ toggle, open, menuId }">
                    <button
                      class="btn btn-ghost btn-sm btn-icon"
                      type="button"
                      :aria-label="`${t.termKor} 행 메뉴`"
                      aria-haspopup="menu"
                      :aria-expanded="open"
                      :aria-controls="menuId"
                      @click="toggle"
                    >
                      <TfIcon name="more" />
                    </button>
                  </template>
                  <template #default="{ close }">
                    <button
                      v-if="canWrite"
                      class="dropdown-item"
                      type="button"
                      role="menuitem"
                      @click="(close(), startEdit(t))"
                    >
                      <TfIcon name="edit" />수정
                    </button>
                    <button
                      class="dropdown-item"
                      type="button"
                      role="menuitem"
                      @click="(close(), (historyId = historyId === t.termId ? null : t.termId))"
                    >
                      <TfIcon name="history" />변경이력
                    </button>
                    <template v-if="canWrite">
                      <div class="dropdown-sep" />
                      <button
                        class="dropdown-item is-danger"
                        type="button"
                        role="menuitem"
                        @click="(close(), askDelete(t))"
                      >
                        <TfIcon name="trash" />삭제
                      </button>
                    </template>
                  </template>
                </TfPopover>
              </td>
            </tr>
            <tr v-if="historyId === t.termId" class="row-msg">
              <td :colspan="COLS">
                <AuditHistory :project-key="key" entity-type="TERM" :entity-id="t.termId" />
              </td>
            </tr>
          </template>
          <tr v-if="page && page.items.length === 0">
            <td :colspan="COLS">
              <EmptyState
                in-table
                icon="book"
                :title="
                  list.q.value ? `'${list.q.value}'에 해당하는 용어가 없습니다` : '용어가 없습니다'
                "
                desc="물리약어(예: RSCH)로도 검색됩니다. 없는 용어는 상단 인라인 행에서 바로 등록하세요 — 입력 2, Enter 1."
              >
                <div v-if="list.q.value" class="row">
                  <TfButton
                    v-if="canWrite"
                    variant="primary"
                    size="sm"
                    icon="plus"
                    @click="prefillFromSearch"
                    >'{{ list.q.value }}' 등록</TfButton
                  >
                  <TfButton variant="secondary" size="sm" @click="list.q.value = ''"
                    >검색 지우기</TfButton
                  >
                </div>
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

    <ConfirmDeleteModal
      :open="deleting !== null"
      :title="`용어 '${deleting?.t.termKor}'을(를) 삭제할까요?`"
      :busy="busy"
      @cancel="deleting = null"
      @confirm="remove"
    >
      <span v-if="deleting && deleting.domainCnt > 0"
        >이 용어를 명칭 조각으로 쓰는 도메인 <strong>{{ deleting.domainCnt }}</strong
        >건은 다음 [재계산] 때 미등록 조각으로 검토필요가 됩니다.</span
      >
      <span v-else>이 용어를 쓰는 도메인은 없습니다.</span>
      삭제는 변경이력에 남습니다.
    </ConfirmDeleteModal>
  </template>
</template>
