<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import {
  BIZ_CD_RE,
  TABLE_PREFIX_RE,
  type BizAreaDeletePreview,
  type BizAreaItem,
  type ValidationIssue,
} from '@termflow/shared';
import { ApiError } from '../api/client.js';
import { projectsApi, type BizAreaBody } from '../api/projects.js';
import ConfirmDeleteModal from '../components/ui/ConfirmDeleteModal.vue';
import EmptyState from '../components/ui/EmptyState.vue';
import TfButton from '../components/ui/TfButton.vue';
import TfIcon from '../components/ui/TfIcon.vue';
import TfPopover from '../components/ui/TfPopover.vue';
import TfToggle from '../components/ui/TfToggle.vue';
import { useSessionStore } from '../stores/session.js';
import { useToastStore } from '../stores/toast.js';

/**
 * 업무구분(`/projects/{key}/biz-areas`, 목업 15, §4.2): 인라인 추가·편집 목록(코드·이름·접두어·정렬·사용·테이블 수·코드구분 수).
 * 테이블이 있는 행은 코드·접두어·사용 여부에 자물쇠 + 툴팁 "테이블 n개가 있어 변경할 수 없습니다", 삭제는 테이블 0건일 때만
 * (확인 모달에 함께 삭제될 코드구분·코드 건수와 영향받는 컬럼 수). 쓰기는 프로젝트 관리자.
 */
const route = useRoute();
const session = useSessionStore();
const toast = useToastStore();
const api = projectsApi();
const key = computed(() => String(route.params['projectKey'] ?? ''));
const project = computed(() => session.projects.find((p) => p.key === key.value) ?? null);
const canWrite = computed(
  () =>
    (session.isSysAdmin || project.value?.role === 'ADMIN') && project.value?.status !== 'ARCHIVED',
);

const rows = ref<BizAreaItem[]>([]);
const loaded = ref(false);
const notFound = ref(false);
async function load(): Promise<void> {
  try {
    rows.value = await api.bizAreas(key.value);
    notFound.value = false;
  } catch (e) {
    notFound.value = e instanceof ApiError && e.status === 404;
  } finally {
    loaded.value = true;
  }
}
watch(key, load, { immediate: true });
const lockTip = (b: BizAreaItem) => `테이블 ${b.tableCnt}개가 있어 변경할 수 없습니다`;

// ── 추가(인라인 행) ───────────────────────────────────────────
const adding = ref(false);
const draft = reactive({
  bizCd: '',
  bizNm: '',
  tablePrefix: '',
  prefixTouched: false,
  sortNo: 0,
  useYn: true,
});
const addErrors = ref<ValidationIssue[]>([]);
function openAdd(): void {
  adding.value = !adding.value;
  Object.assign(draft, {
    bizCd: '',
    bizNm: '',
    tablePrefix: '',
    prefixTouched: false,
    sortNo: Math.max(0, ...rows.value.map((r) => r.sortNo)) + 1,
    useYn: true,
  });
  addErrors.value = [];
}
watch(
  () => draft.bizCd,
  (v) => {
    const up = v.toUpperCase().replace(/\s/g, '');
    if (up !== v) draft.bizCd = up;
    else if (!draft.prefixTouched) draft.tablePrefix = up ? `${up}_` : '';
  },
);
const cdOk = computed(() => BIZ_CD_RE.test(draft.bizCd));
const cdTaken = computed(() => rows.value.some((r) => r.bizCd === draft.bizCd));
const prefixOk = computed(
  () => draft.tablePrefix === '' || TABLE_PREFIX_RE.test(draft.tablePrefix),
);
const canAdd = computed(
  () => cdOk.value && !cdTaken.value && prefixOk.value && draft.bizNm.trim() !== '',
);
const busy = ref(false);
function errMsg(e: unknown, fallback: string): string {
  if (e instanceof ApiError && e.problem) {
    const errs = (e.problem['errors'] as ValidationIssue[] | undefined) ?? [];
    return errs.length
      ? errs.map((x) => `${x.field ?? ''} ${x.message}`.trim()).join(' · ')
      : (e.problem.detail ?? fallback);
  }
  return fallback;
}
async function add(): Promise<void> {
  if (!canAdd.value) return;
  busy.value = true;
  try {
    const b = await api.createBizArea(key.value, {
      bizCd: draft.bizCd,
      bizNm: draft.bizNm.trim(),
      tablePrefix: draft.tablePrefix === '' ? null : draft.tablePrefix,
      sortNo: draft.sortNo,
      useYn: draft.useYn,
      description: null,
    });
    toast.success(`업무구분 ${b.bizCd} ${b.bizNm}을(를) 추가했습니다`);
    adding.value = false;
    await load();
  } catch (e) {
    toast.error(errMsg(e, '추가하지 못했습니다'));
  } finally {
    busy.value = false;
  }
}

// ── 편집 ─────────────────────────────────────────────────────
const editingId = ref<number | null>(null);
const edit = reactive({
  bizCd: '',
  bizNm: '',
  tablePrefix: '',
  sortNo: 0,
  useYn: true,
  description: '',
});
function startEdit(b: BizAreaItem): void {
  editingId.value = b.bizAreaId;
  Object.assign(edit, {
    bizCd: b.bizCd,
    bizNm: b.bizNm,
    tablePrefix: b.tablePrefix ?? '',
    sortNo: b.sortNo,
    useYn: b.useYn,
    description: b.description ?? '',
  });
}
function body(b: BizAreaItem, patch: Partial<BizAreaBody> = {}): BizAreaBody {
  return {
    bizCd: b.bizCd,
    bizNm: b.bizNm,
    tablePrefix: b.tablePrefix,
    sortNo: b.sortNo,
    useYn: b.useYn,
    description: b.description,
    ...patch,
  };
}
async function saveEdit(b: BizAreaItem): Promise<void> {
  busy.value = true;
  try {
    await api.updateBizArea(
      key.value,
      b.bizAreaId,
      body(b, {
        bizCd: edit.bizCd.toUpperCase(),
        bizNm: edit.bizNm.trim(),
        tablePrefix: edit.tablePrefix === '' ? null : edit.tablePrefix.toUpperCase(),
        sortNo: Number(edit.sortNo) || 0,
        useYn: edit.useYn,
        description: edit.description.trim() || null,
      }),
    );
    toast.success(`${edit.bizCd} ${edit.bizNm} 저장했습니다`);
    editingId.value = null;
    await load();
  } catch (e) {
    toast.error(errMsg(e, '저장하지 못했습니다'));
  } finally {
    busy.value = false;
  }
}
async function toggleUse(b: BizAreaItem, useYn: boolean): Promise<void> {
  try {
    await api.updateBizArea(key.value, b.bizAreaId, body(b, { useYn }));
    toast.success(`${b.bizCd} ${useYn ? '사용' : '사용 중지'}`);
  } catch (e) {
    toast.error(errMsg(e, '바꾸지 못했습니다'));
  }
  await load();
}

// ── 삭제 ─────────────────────────────────────────────────────
const deleting = ref<{ b: BizAreaItem; p: BizAreaDeletePreview } | null>(null);
async function askDelete(b: BizAreaItem): Promise<void> {
  try {
    deleting.value = { b, p: await api.bizAreaDeletePreview(key.value, b.bizAreaId) };
  } catch (e) {
    toast.error(errMsg(e, '삭제 정보를 불러오지 못했습니다'));
  }
}
async function remove(): Promise<void> {
  if (!deleting.value) return;
  busy.value = true;
  const { b } = deleting.value;
  try {
    const r = await api.deleteBizArea(key.value, b.bizAreaId);
    toast.success(`${b.bizCd} 삭제 · 코드구분 ${r.deletedCodeCls} · 코드 ${r.deletedCodes}`);
    deleting.value = null;
    await load();
  } catch (e) {
    toast.error(errMsg(e, '삭제하지 못했습니다'));
  } finally {
    busy.value = false;
  }
}
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
          ><span>›</span><span>프로젝트</span><span>›</span><span>업무구분</span>
        </div>
        <h1 class="page-title">
          업무구분 <span class="count-pill">{{ rows.length }}</span>
        </h1>
        <p class="page-desc">
          이 프로젝트 안의 업무 영역입니다. 테이블 물리명 접두어와 코드정보 업무구분의 공통
          마스터이며, 모든 테이블은 업무구분 하나에 속합니다(A6).
          {{ canWrite ? '' : '프로젝트 관리자만 편집할 수 있습니다.' }}
        </p>
      </div>
      <div v-if="canWrite" class="page-actions">
        <TfButton variant="primary" icon="plus" :aria-expanded="adding" @click="openAdd"
          >업무구분 추가</TfButton
        >
      </div>
    </div>

    <div class="alert alert-info mb-4">
      <TfIcon name="info" />
      <div class="alert-body">
        프로젝트 키 <span class="mono">{{ key }}</span
        >는 URL·식별용이고, 테이블 접두어는 업무구분이 정합니다(A4). 예: 업무구분 RP의 새 테이블
        '연구과제마스터' → <span class="mono">RP_RSCH_PRJ_MST</span>. 공통 테이블은
        <span class="mono">CM 공통</span> 업무구분을 만들어 쓰세요.
      </div>
    </div>

    <div class="table-wrap">
      <table class="table">
        <caption class="sr-only">
          업무구분 목록
        </caption>
        <thead>
          <tr>
            <th>코드</th>
            <th>이름</th>
            <th>테이블 접두어</th>
            <th class="num">테이블</th>
            <th class="num">코드구분</th>
            <th>사용</th>
            <th class="num">정렬</th>
            <th>출처</th>
            <th class="col-menu" />
          </tr>
        </thead>
        <tbody>
          <template v-if="adding">
            <tr class="is-inline-new">
              <td>
                <input
                  v-model="draft.bizCd"
                  :class="[
                    'input',
                    'mono',
                    'w-80',
                    { 'is-invalid': draft.bizCd !== '' && (!cdOk || cdTaken) },
                  ]"
                  maxlength="10"
                  aria-label="코드"
                  placeholder="CM"
                  @keydown.enter="add"
                />
              </td>
              <td>
                <input
                  v-model="draft.bizNm"
                  class="input"
                  aria-label="이름"
                  maxlength="100"
                  placeholder="공통"
                  @keydown.enter="add"
                />
              </td>
              <td>
                <input
                  v-model="draft.tablePrefix"
                  :class="['input', 'mono', 'w-100', { 'is-invalid': !prefixOk }]"
                  maxlength="20"
                  aria-label="테이블 접두어"
                  @input="draft.prefixTouched = true"
                />
              </td>
              <td class="num text-muted">0</td>
              <td class="num text-muted">0</td>
              <td><TfToggle v-model="draft.useYn" aria-label="사용" /></td>
              <td class="num">
                <input
                  v-model.number="draft.sortNo"
                  class="input w-80"
                  type="number"
                  min="0"
                  aria-label="정렬"
                />
              </td>
              <td colspan="2" class="nowrap">
                <TfButton
                  variant="primary"
                  size="sm"
                  :disabled="!canAdd"
                  :loading="busy"
                  kbd="Enter"
                  @click="add"
                  >추가</TfButton
                >
                {{ ' ' }}<TfButton variant="ghost" size="sm" @click="adding = false">취소</TfButton>
              </td>
            </tr>
            <tr class="row-msg">
              <td colspan="9">
                <div class="row wrap text-sm">
                  <span v-if="draft.bizCd && cdOk && !cdTaken" class="text-success"
                    ><TfIcon name="check" size="sm" /> 코드 {{ draft.bizCd }} 사용 가능</span
                  >
                  <span v-else-if="cdTaken" class="text-danger"
                    ><TfIcon name="alert-circle" size="sm" /> 같은 코드가 있습니다</span
                  >
                  <span v-else-if="draft.bizCd" class="text-danger"
                    ><TfIcon name="alert-circle" size="sm" /> 코드는 영문 대문자로 시작하는 영문
                    대문자·숫자 2~10자</span
                  >
                  <span class="text-muted"
                    >· 접두어 기본값은 코드 + '_'(변경 가능, 비우면 접두어 없음) · 코드구분은 코드
                    화면에서 추가</span
                  >
                </div>
              </td>
            </tr>
          </template>

          <template v-for="b in rows" :key="b.bizAreaId">
            <tr v-if="editingId === b.bizAreaId" class="is-editing">
              <td>
                <input
                  v-model="edit.bizCd"
                  class="input mono w-80"
                  maxlength="10"
                  aria-label="코드"
                  :disabled="b.locked"
                  :title="b.locked ? lockTip(b) : ''"
                />
              </td>
              <td>
                <input v-model="edit.bizNm" class="input" maxlength="100" aria-label="이름" />
              </td>
              <td>
                <input
                  v-model="edit.tablePrefix"
                  class="input mono w-100"
                  maxlength="20"
                  aria-label="테이블 접두어"
                  :disabled="b.locked"
                  :title="b.locked ? lockTip(b) : ''"
                />
              </td>
              <td class="num">{{ b.tableCnt }}</td>
              <td class="num">{{ b.codeClsCnt }}</td>
              <td>
                <TfToggle v-model="edit.useYn" aria-label="사용" :disabled="b.locked && b.useYn" />
              </td>
              <td class="num">
                <input
                  v-model.number="edit.sortNo"
                  class="input w-80"
                  type="number"
                  min="0"
                  aria-label="정렬"
                />
              </td>
              <td colspan="2" class="nowrap">
                <TfButton variant="primary" size="sm" :loading="busy" @click="saveEdit(b)"
                  >저장</TfButton
                >
                {{ ' '
                }}<TfButton variant="ghost" size="sm" @click="editingId = null">취소</TfButton>
              </td>
            </tr>
            <tr v-else :class="{ 'is-disabled': !b.useYn }">
              <td class="mono fw-600">
                {{ b.bizCd }}
                <span
                  v-if="b.locked"
                  class="text-muted"
                  :title="lockTip(b)"
                  :aria-label="lockTip(b)"
                  role="img"
                  ><TfIcon name="lock" size="sm"
                /></span>
              </td>
              <td>{{ b.bizNm }}</td>
              <td class="mono">{{ b.tablePrefix ?? '—' }}</td>
              <td class="num">{{ b.tableCnt }}</td>
              <td class="num">{{ b.codeClsCnt }}</td>
              <td>
                <TfToggle
                  :model-value="b.useYn"
                  :aria-label="`${b.bizCd} 사용`"
                  :disabled="!canWrite || (b.locked && b.useYn)"
                  :title="b.locked && b.useYn ? lockTip(b) : ''"
                  @update:model-value="(v: boolean) => toggleUse(b, v)"
                />
              </td>
              <td class="num">{{ b.sortNo }}</td>
              <td class="text-muted">
                {{ b.origin ? (b.origin.projectNm ?? '원본 삭제됨') : '직접 등록'
                }}{{ b.useYn ? '' : ' · 사용 중지' }}
              </td>
              <td class="col-menu">
                <TfPopover v-if="canWrite" align="right">
                  <template #trigger="{ toggle, open, menuId }">
                    <button
                      class="btn btn-ghost btn-sm btn-icon"
                      type="button"
                      :aria-label="`${b.bizCd} 행 메뉴`"
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
                      @click="(close(), startEdit(b))"
                    >
                      <TfIcon name="edit" />수정
                    </button>
                    <div class="dropdown-sep" />
                    <button
                      class="dropdown-item is-danger"
                      type="button"
                      role="menuitem"
                      :disabled="b.locked"
                      :title="b.locked ? `${lockTip(b)} — 삭제 불가` : ''"
                      @click="(close(), askDelete(b))"
                    >
                      <TfIcon name="trash" />삭제{{ b.locked ? ' (테이블 있음)' : '' }}
                    </button>
                  </template>
                </TfPopover>
              </td>
            </tr>
            <tr v-if="editingId === b.bizAreaId && b.locked" class="row-msg">
              <td colspan="9">
                <span class="text-sm text-muted"
                  ><TfIcon name="lock" size="sm" /> 테이블 {{ b.tableCnt }}개가 있어 코드·접두어는
                  바꿀 수 없고 사용 중지도 할 수 없습니다. 이름·정렬만 수정 가능합니다.</span
                >
              </td>
            </tr>
          </template>
          <tr v-if="loaded && rows.length === 0 && !adding">
            <td colspan="9">
              <EmptyState
                in-table
                icon="folder"
                title="업무구분이 없습니다"
                desc="테이블을 만들려면 업무구분이 하나 이상 필요합니다."
              />
            </td>
          </tr>
        </tbody>
      </table>
      <div class="table-footer">
        사용 중지된 업무구분은 새 테이블·새 코드구분 선택지에 나오지 않습니다 · 테이블 0개인
        업무구분만 삭제할 수 있고, 코드구분·코드도 함께 삭제됩니다(C4)
      </div>
    </div>

    <ConfirmDeleteModal
      :open="deleting !== null"
      :title="`업무구분 ${deleting?.b.bizCd} ${deleting?.b.bizNm}을(를) 삭제할까요?`"
      :busy="busy"
      @cancel="deleting = null"
      @confirm="remove"
    >
      <span data-testid="delete-counts"
        >소속 코드구분 <strong>{{ deleting?.p.codeClsCnt }}</strong
        >개 · 코드 <strong>{{ deleting?.p.codeCnt }}</strong
        >개가 함께 삭제됩니다.</span
      >
      <template v-if="deleting && deleting.p.referencingColumnCnt > 0">
        다른 업무구분 테이블의 컬럼 <strong>{{ deleting.p.referencingColumnCnt }}</strong
        >개가 이 코드구분을 참조하고 있어 연결이 해제되고 '코드구분 삭제됨' 경고가 표시됩니다.
      </template>
    </ConfirmDeleteModal>
  </template>
</template>
