<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import {
  checkStdTypeParts,
  STD_TYPES,
  stdTypeProblemIssue,
  typeText,
  validateSuffix,
  type DomainClsItem,
  type DomainClsPage,
  type StdType,
} from '@termflow/shared';
import { standardsApi, type DomainClsBody } from '../api/standards.js';
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
 * 도메인분류(`/projects/{key}/standards/domain-classes`, 목업 05, §3.5.6): 접미어 → 타입·길이·스케일. 첫 행 인라인 등록,
 * 행 인라인 편집(연결 도메인이 있으면 접미어 잠금), 사용 도메인 수·예시, 사용 중 삭제는 확인 후 분류 연결 해제(`?force=true`).
 * 타입을 바꿔도 도메인은 자동으로 바뀌지 않는다 — 도메인 화면 [재계산](§4.8).
 */
const { key, project, canWrite } = useProject();
const api = standardsApi();
const toast = useToastStore();
const list = useServerList<DomainClsItem, DomainClsPage>({
  filters: ['colType', 'review'],
  defaultSize: 50,
  enabled: () => key.value !== '',
  fetch: (q) => api.domainClasses(key.value, q),
});
watch(key, () => void list.reload(), { immediate: true });
const page = computed(() => list.data.value);
const notFound = computed(() => (list.error.value as { status?: number } | null)?.status === 404);
const reviewSegs = computed(() => [
  { value: '', label: '전체', count: page.value?.counts.all },
  { value: 'true', label: '검토 표시', count: page.value?.counts.review },
]);
const colTypeFilter = computed({
  get: () => list.filters['colType'] ?? '',
  set: (v: string) => list.setFilter('colType', v),
});
const SORTS = [
  { value: '', label: '접미어 ↑' },
  { value: 'domainCnt,desc', label: '사용 도메인 수 ↓' },
  { value: 'updatedAt,desc', label: '수정일 ↓' },
];
const sortValue = computed({
  get: () => (list.sort.value ? `${list.sort.value.key},${list.sort.value.dir}` : ''),
  set: (v: string) => {
    const [k, d] = v.split(',');
    list.sort.value = k ? { key: k, dir: d === 'desc' ? 'desc' : 'asc' } : null;
  },
});

interface Draft {
  suffix: string;
  clsNm: string;
  colType: StdType;
  colLength: string;
  colScale: string;
  description: string;
}
const empty = (): Draft => ({
  suffix: '',
  clsNm: '',
  colType: 'VARCHAR',
  colLength: '',
  colScale: '',
  description: '',
});
const num = (v: string) => (v.trim() === '' ? null : Number(v));
function toBody(d: Draft): DomainClsBody {
  return {
    suffix: d.suffix.trim().toUpperCase(),
    clsNm: d.clsNm.trim(),
    colType: d.colType,
    colLength: num(d.colLength),
    colScale: num(d.colScale),
    description: d.description.trim() || null,
  };
}
function issuesOf(d: Draft): string[] {
  const b = toBody(d);
  const out = validateSuffix(b.suffix || null).map((i) => i.message);
  if (
    (b.colLength !== null && !Number.isInteger(b.colLength)) ||
    (b.colScale !== null && !Number.isInteger(b.colScale))
  )
    out.push('길이·스케일은 정수입니다');
  else {
    const p = checkStdTypeParts(b.colType, b.colLength, b.colScale);
    if (p) out.push(stdTypeProblemIssue(p, b.colType).message);
  }
  if (!b.clsNm) out.push('분류명을 입력하세요');
  return out;
}
const lenAllowed = (t: StdType) => ['VARCHAR', 'CHAR', 'NUMERIC', 'TIMESTAMP'].includes(t);
const preview = (d: Draft) => typeText(d.colType, num(d.colLength), num(d.colScale)) ?? d.colType;

const draft = reactive<Draft>(empty());
const draftIssues = computed(() => (draft.suffix || draft.clsNm ? issuesOf(draft) : []));
const taken = computed(
  () =>
    draft.suffix.trim() !== '' &&
    (page.value?.items ?? []).some((c) => c.suffix === draft.suffix.trim().toUpperCase()),
);
const busy = ref(false);
function warnToast(ws: { message: string }[]): void {
  for (const w of ws) toast.info(w.message, 6000);
}
async function add(): Promise<void> {
  if (busy.value || draftIssues.value.length > 0 || !draft.suffix) return;
  busy.value = true;
  try {
    const r = await api.createDomainCls(key.value, toBody(draft));
    toast.success(`${r.domainCls.suffix} ${r.domainCls.typeText} 등록했습니다`);
    warnToast(r.warnings);
    Object.assign(draft, empty());
    await list.reload();
  } catch (e) {
    toast.error(errMsg(e, '등록하지 못했습니다'));
  } finally {
    busy.value = false;
  }
}

const editingId = ref<number | null>(null);
const edit = reactive<Draft>(empty());
function startEdit(c: DomainClsItem): void {
  editingId.value = c.domainClsId;
  Object.assign(edit, {
    suffix: c.suffix,
    clsNm: c.clsNm,
    colType: c.colType,
    colLength: c.colLength === null ? '' : String(c.colLength),
    colScale: c.colScale === null ? '' : String(c.colScale),
    description: c.description ?? '',
  });
}
async function saveEdit(c: DomainClsItem): Promise<void> {
  const issues = issuesOf(edit);
  if (issues.length) {
    toast.error(issues.join(' · '));
    return;
  }
  busy.value = true;
  try {
    const r = await api.updateDomainCls(key.value, c.domainClsId, toBody(edit));
    toast.success(`${r.domainCls.suffix} 저장했습니다`);
    warnToast(r.warnings);
    editingId.value = null;
    await list.reload();
  } catch (e) {
    toast.error(errMsg(e, '저장하지 못했습니다'));
  } finally {
    busy.value = false;
  }
}
const deleting = ref<DomainClsItem | null>(null);
async function remove(): Promise<void> {
  const c = deleting.value;
  if (!c) return;
  busy.value = true;
  try {
    const r = await api.deleteDomainCls(key.value, c.domainClsId, c.domainCnt > 0);
    toast.success(
      `${c.suffix} 삭제했습니다${r.unlinkedDomains ? ` · 도메인 ${r.unlinkedDomains}건 분류 연결 해제` : ''}`,
    );
    deleting.value = null;
    await list.reload();
  } catch (e) {
    toast.error(errMsg(e, '삭제하지 못했습니다'));
  } finally {
    busy.value = false;
  }
}
const COLS = 10;
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
          ><span>›</span><span>표준 사전</span><span>›</span><span>도메인분류</span>
        </div>
        <h1 class="page-title">
          도메인분류 <span class="count-pill">{{ fmtNum(page?.counts.all) }}</span>
        </h1>
        <p class="page-desc">
          접미어(AMT, CD, TP …) → 데이터타입·길이·스케일 규칙. 도메인 자동계산(L1)의 타입 결정
          근거이며 이 프로젝트 전용 사본입니다. NUMERIC은 정밀도·스케일을 분리 저장합니다.
          {{ canWrite ? '' : '프로젝트 관리자만 편집할 수 있습니다.' }}
        </p>
      </div>
      <div v-if="canWrite" class="page-actions">
        <RouterLink
          class="btn btn-secondary"
          :to="`/projects/${key}/standards/domain-classes/import`"
          ><TfIcon name="upload" />일괄 등록</RouterLink
        >
      </div>
    </div>

    <div class="alert alert-info mb-4">
      <TfIcon name="info" />
      <div class="alert-body">
        접미어를 등록·수정해도 기존 도메인의 타입은 바로 바뀌지 않습니다. 도메인 화면에서
        <strong>[재계산]</strong>을 실행하면 이 프로젝트의 도메인만 다시 계산됩니다(수기 타입 유지).
      </div>
      <div class="alert-actions">
        <RouterLink
          class="btn btn-secondary btn-sm"
          :to="`/projects/${key}/standards/domains?review=true`"
          >검토필요 도메인 보기</RouterLink
        >
      </div>
    </div>

    <div class="toolbar">
      <SearchBox
        v-model="list.q.value"
        label="도메인분류 검색"
        placeholder="접미어 · 분류명 검색"
      />
      <select v-model="colTypeFilter" class="select w-160" aria-label="타입 필터">
        <option value="">모든 타입</option>
        <option v-for="t in STD_TYPES" :key="t" :value="t">{{ t }}</option>
      </select>
      <FilterSeg
        :model-value="list.filters['review'] ?? ''"
        :options="reviewSegs"
        label="검토 필터"
        @change="(v: string) => list.setFilter('review', v)"
      />
      <select v-model="sortValue" class="select w-160" aria-label="정렬">
        <option v-for="o in SORTS" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </div>

    <div class="table-wrap">
      <table class="table">
        <caption class="sr-only">
          도메인분류 목록
        </caption>
        <thead>
          <tr>
            <th>접미어</th>
            <th>분류명</th>
            <th>타입</th>
            <th class="num">길이</th>
            <th class="num">스케일</th>
            <th>결과 타입</th>
            <th>예시 도메인</th>
            <th class="num">사용 도메인</th>
            <th>수정</th>
            <th class="col-menu" />
          </tr>
        </thead>
        <tbody>
          <template v-if="canWrite">
            <tr
              class="is-inline-new"
              @keydown.enter.prevent="add"
              @keydown.esc="Object.assign(draft, empty())"
            >
              <td>
                <input
                  v-model="draft.suffix"
                  :class="['input', 'mono', 'w-100', { 'is-invalid': taken }]"
                  aria-label="접미어"
                  placeholder="MEMO"
                  maxlength="30"
                  @input="draft.suffix = draft.suffix.toUpperCase()"
                />
              </td>
              <td>
                <input v-model="draft.clsNm" class="input" aria-label="분류명" placeholder="메모" />
              </td>
              <td>
                <select v-model="draft.colType" class="select w-120" aria-label="타입">
                  <option v-for="t in STD_TYPES" :key="t" :value="t">{{ t }}</option>
                </select>
              </td>
              <td>
                <input
                  v-model="draft.colLength"
                  class="input w-80 num"
                  aria-label="길이"
                  :disabled="!lenAllowed(draft.colType)"
                  inputmode="numeric"
                />
              </td>
              <td>
                <input
                  v-model="draft.colScale"
                  class="input w-80 num"
                  aria-label="스케일"
                  :disabled="draft.colType !== 'NUMERIC'"
                  inputmode="numeric"
                />
              </td>
              <td class="mono">{{ preview(draft) }}</td>
              <td class="text-muted">—</td>
              <td class="num text-muted">—</td>
              <td colspan="2" class="nowrap">
                <TfButton
                  variant="primary"
                  size="sm"
                  kbd="Enter"
                  :disabled="draftIssues.length > 0 || !draft.suffix || taken"
                  :loading="busy"
                  @click="add"
                  >등록</TfButton
                >
              </td>
            </tr>
            <tr v-if="draft.suffix || draft.clsNm" class="row-msg">
              <td :colspan="COLS">
                <div class="row wrap text-sm">
                  <span v-if="taken" class="text-danger"
                    ><TfIcon name="alert-circle" size="sm" /> 같은 접미어가 있습니다</span
                  >
                  <span v-for="m in draftIssues" :key="m" class="text-danger"
                    ><TfIcon name="alert-circle" size="sm" /> {{ m }}</span
                  >
                  <span v-if="!taken && draftIssues.length === 0" class="text-success"
                    ><TfIcon name="check" size="sm" /> 접미어 {{ draft.suffix }} 등록 가능</span
                  >
                  <span class="text-muted">· 등록 후 도메인 [재계산]으로 타입이 반영됩니다</span>
                </div>
              </td>
            </tr>
          </template>
          <tr v-if="list.loading.value && !page">
            <td :colspan="COLS"><TfSkeleton :lines="5" /></td>
          </tr>
          <template v-for="c in page?.items ?? []" :key="c.domainClsId">
            <tr
              v-if="editingId === c.domainClsId"
              class="is-editing"
              @keydown.enter.prevent="saveEdit(c)"
              @keydown.esc="editingId = null"
            >
              <td>
                <input
                  v-model="edit.suffix"
                  class="input mono w-100"
                  aria-label="접미어"
                  :readonly="c.domainCnt > 0"
                  :title="
                    c.domainCnt > 0 ? `도메인 ${c.domainCnt}건이 쓰고 있어 바꿀 수 없습니다` : ''
                  "
                />
              </td>
              <td><input v-model="edit.clsNm" class="input" aria-label="분류명" /></td>
              <td>
                <select v-model="edit.colType" class="select w-120" aria-label="타입">
                  <option v-for="t in STD_TYPES" :key="t" :value="t">{{ t }}</option>
                </select>
              </td>
              <td>
                <input
                  v-model="edit.colLength"
                  class="input w-80 num"
                  aria-label="길이"
                  :disabled="!lenAllowed(edit.colType)"
                />
              </td>
              <td>
                <input
                  v-model="edit.colScale"
                  class="input w-80 num"
                  aria-label="스케일"
                  :disabled="edit.colType !== 'NUMERIC'"
                />
              </td>
              <td class="mono">{{ preview(edit) }}</td>
              <td class="text-2">{{ c.sample?.logicalNm ?? '—' }}</td>
              <td class="num">{{ fmtNum(c.domainCnt) }}</td>
              <td colspan="2" class="nowrap">
                <TfButton
                  variant="primary"
                  size="sm"
                  kbd="Enter"
                  :loading="busy"
                  @click="saveEdit(c)"
                  >저장</TfButton
                >
                {{ ' '
                }}<TfButton variant="ghost" size="sm" kbd="Esc" @click="editingId = null"
                  >취소</TfButton
                >
              </td>
            </tr>
            <tr v-else>
              <td class="mono fw-600">
                {{ c.suffix }}
                <span
                  v-if="c.reviewYn"
                  class="badge badge-warning"
                  title="승계 시 제안 타입(확인 필요)"
                  >검토</span
                >
              </td>
              <td>{{ c.clsNm }}</td>
              <td class="mono">{{ c.colType }}</td>
              <td class="num">{{ c.colLength ?? '—' }}</td>
              <td class="num">{{ c.colScale ?? '—' }}</td>
              <td class="mono">{{ c.typeText }}</td>
              <td class="text-2">
                {{ c.sample?.logicalNm ?? '—' }}
                <span v-if="c.sample?.physicalNm" class="mono text-muted">{{
                  c.sample.physicalNm
                }}</span>
              </td>
              <td class="num">
                <RouterLink
                  v-if="c.domainCnt > 0"
                  :to="`/projects/${key}/standards/domains?suffix=${encodeURIComponent(c.suffix)}`"
                  >{{ fmtNum(c.domainCnt) }}</RouterLink
                ><span v-else class="text-muted">0</span>
              </td>
              <td class="text-muted nowrap">
                {{ c.updatedBy }} · {{ fmtTs(c.updatedAt).slice(0, 10) }}
              </td>
              <td class="col-menu">
                <TfPopover v-if="canWrite" align="right">
                  <template #trigger="{ toggle, open, menuId }">
                    <button
                      class="btn btn-ghost btn-sm btn-icon"
                      type="button"
                      :aria-label="`${c.suffix} 행 메뉴`"
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
                      class="dropdown-item"
                      type="button"
                      role="menuitem"
                      @click="(close(), startEdit(c))"
                    >
                      <TfIcon name="edit" />수정
                    </button>
                    <div class="dropdown-sep" />
                    <button
                      class="dropdown-item is-danger"
                      type="button"
                      role="menuitem"
                      @click="(close(), (deleting = c))"
                    >
                      <TfIcon name="trash" />삭제
                    </button>
                  </template>
                </TfPopover>
              </td>
            </tr>
          </template>
          <tr v-if="page && page.items.length === 0">
            <td :colspan="COLS">
              <EmptyState
                in-table
                icon="tag"
                title="도메인분류가 없습니다"
                desc="첫 행에서 접미어를 등록하세요."
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

    <ConfirmDeleteModal
      :open="deleting !== null"
      :title="`도메인분류 ${deleting?.suffix}을(를) 삭제할까요?`"
      :busy="busy"
      :confirm-label="deleting && deleting.domainCnt > 0 ? '연결 해제 후 삭제' : '삭제'"
      @cancel="deleting = null"
      @confirm="remove"
    >
      <span v-if="deleting && deleting.domainCnt > 0" data-testid="cls-delete-warn"
        >이 접미어를 쓰는 도메인 <strong>{{ fmtNum(deleting.domainCnt) }}</strong
        >건의 분류 연결이 해제됩니다. 도메인 타입은 그대로 남고, 다음 [재계산] 때 검토필요가 될 수
        있습니다.</span
      >
      <span v-else>이 접미어를 쓰는 도메인은 없습니다.</span>
    </ConfirmDeleteModal>
  </template>
</template>
