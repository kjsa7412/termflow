<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import type { BizAreaItem, CodeClsDetail, CodeClsItem, CodeItem } from '@termflow/shared';
import { projectsApi } from '../api/projects.js';
import { standardsApi, type CodeBody } from '../api/standards.js';
import SearchBox from '../components/std/SearchBox.vue';
import ConfirmDeleteModal from '../components/ui/ConfirmDeleteModal.vue';
import EmptyState from '../components/ui/EmptyState.vue';
import TfButton from '../components/ui/TfButton.vue';
import TfIcon from '../components/ui/TfIcon.vue';
import TfSkeleton from '../components/ui/TfSkeleton.vue';
import TfToggle from '../components/ui/TfToggle.vue';
import { errMsg, fmtNum, useProject } from '../composables/useProject.js';
import { useToastStore } from '../stores/toast.js';

/**
 * 코드(`/projects/{key}/standards/codes`, 목업 07, §4.2·§3.5.8~9): 좌측 트리 최상위 = 프로젝트 업무구분 → 코드구분(건수) →
 * 우측 코드 인라인 편집. 코드구분은 (업무구분, 코드구분) 쌍으로 구분하며, 사용 중지 업무구분에는 새 코드구분을 만들 수 없다.
 * 선택은 `?cls=`로 유지한다.
 */
const route = useRoute();
const router = useRouter();
const { key, project, canWrite } = useProject();
const api = standardsApi();
const papi = projectsApi();
const toast = useToastStore();

const bizAreas = ref<BizAreaItem[]>([]);
const classes = ref<CodeClsItem[]>([]);
const treeLoading = ref(true);
const notFound = ref(false);
const treeQ = ref('');
const expanded = reactive<Record<number, boolean>>({});
const selectedId = ref<number | null>(Number(route.query['cls']) || null);
const detail = ref<CodeClsDetail | null>(null);
const busy = ref(false);

async function loadTree(): Promise<void> {
  treeLoading.value = true;
  try {
    const [b, first] = await Promise.all([
      papi.bizAreas(key.value),
      api.codeClasses(key.value, { size: 200, q: treeQ.value || undefined }),
    ]);
    const all = [...first.items];
    for (let p = 2; all.length < first.total; p++) {
      all.push(
        ...(await api.codeClasses(key.value, { size: 200, page: p, q: treeQ.value || undefined }))
          .items,
      );
    }
    bizAreas.value = b;
    classes.value = all;
    notFound.value = false;
    const sel = all.find((c) => c.codeClsId === selectedId.value);
    if (sel) expanded[sel.bizAreaId] = true;
    else if (treeQ.value) for (const c of all) expanded[c.bizAreaId] = true;
  } catch (e) {
    notFound.value = (e as { status?: number }).status === 404;
  } finally {
    treeLoading.value = false;
  }
}
let qTimer: ReturnType<typeof setTimeout> | null = null;
watch(treeQ, () => {
  if (qTimer) clearTimeout(qTimer);
  qTimer = setTimeout(() => void loadTree(), 250);
});
const byBiz = computed(() => {
  const m = new Map<number, CodeClsItem[]>();
  for (const c of classes.value) m.set(c.bizAreaId, [...(m.get(c.bizAreaId) ?? []), c]);
  return m;
});
const totals = computed(() => ({
  cls: classes.value.length,
  code: classes.value.reduce((n, c) => n + c.codeCnt, 0),
}));

const includeInactive = ref(true);
const codeQ = ref('');
async function loadDetail(): Promise<void> {
  if (!selectedId.value) {
    detail.value = null;
    return;
  }
  try {
    detail.value = await api.codeCls(key.value, selectedId.value, {
      includeInactive: includeInactive.value ? undefined : 'false',
    });
  } catch (e) {
    detail.value = null;
    toast.error(errMsg(e, '코드구분을 불러오지 못했습니다'));
  }
}
function select(c: CodeClsItem): void {
  selectedId.value = c.codeClsId;
  void router.replace({ query: { ...route.query, cls: String(c.codeClsId) } });
}
watch([selectedId, includeInactive], () => void loadDetail());
watch(
  key,
  async () => {
    await loadTree();
    await loadDetail();
  },
  { immediate: true },
);
const codes = computed(() =>
  (detail.value?.codes ?? []).filter(
    (x) => !codeQ.value || x.code.includes(codeQ.value) || x.codeNm.includes(codeQ.value),
  ),
);
const summary = computed(() => {
  const d = detail.value;
  if (!d) return '';
  const active = d.codes.filter((x) => x.isActive).slice(0, 10);
  return `${d.codeCls.codeClsNm}(${d.codeCls.bizCd}/${d.codeCls.codeCls}: ${active
    .map((x) => `${x.code} ${x.codeNm}`)
    .join(', ')}${d.codes.filter((x) => x.isActive).length > 10 ? ' …' : ''})`;
});

// ── 코드구분 추가·이름 변경·삭제 ─────────────────────────────────
const addFor = ref<number | null>(null);
const newCls = reactive({ codeCls: '', codeClsNm: '' });
function openAddCls(b: BizAreaItem): void {
  addFor.value = addFor.value === b.bizAreaId ? null : b.bizAreaId;
  expanded[b.bizAreaId] = true;
  Object.assign(newCls, { codeCls: '', codeClsNm: '' });
}
async function addCls(): Promise<void> {
  if (!addFor.value || !newCls.codeCls.trim() || !newCls.codeClsNm.trim()) return;
  busy.value = true;
  try {
    const r = await api.createCodeCls(key.value, {
      bizAreaId: addFor.value,
      codeCls: newCls.codeCls.trim(),
      codeClsNm: newCls.codeClsNm.trim(),
      description: null,
    });
    toast.success(`코드구분 ${r.bizCd}/${r.codeCls} ${r.codeClsNm} 추가했습니다`);
    addFor.value = null;
    await loadTree();
    select(r);
  } catch (e) {
    toast.error(errMsg(e, '추가하지 못했습니다'));
  } finally {
    busy.value = false;
  }
}
const renaming = ref(false);
const rename = reactive({ codeCls: '', codeClsNm: '' });
function startRename(): void {
  if (!detail.value) return;
  renaming.value = true;
  Object.assign(rename, {
    codeCls: detail.value.codeCls.codeCls,
    codeClsNm: detail.value.codeCls.codeClsNm,
  });
}
async function saveRename(): Promise<void> {
  const d = detail.value;
  if (!d) return;
  busy.value = true;
  try {
    await api.updateCodeCls(key.value, d.codeCls.codeClsId, {
      bizAreaId: d.codeCls.bizAreaId,
      codeCls: rename.codeCls.trim(),
      codeClsNm: rename.codeClsNm.trim(),
      description: d.codeCls.description,
    });
    renaming.value = false;
    toast.success('코드구분을 저장했습니다');
    await Promise.all([loadTree(), loadDetail()]);
  } catch (e) {
    toast.error(errMsg(e, '저장하지 못했습니다'));
  } finally {
    busy.value = false;
  }
}
const deletingCls = ref(false);
async function removeCls(): Promise<void> {
  const d = detail.value;
  if (!d) return;
  busy.value = true;
  try {
    const r = await api.deleteCodeCls(key.value, d.codeCls.codeClsId);
    toast.success(`코드구분 삭제 · 코드 ${r.deletedCodes} · 연결 해제 컬럼 ${r.affectedColumns}`);
    deletingCls.value = false;
    selectedId.value = null;
    await loadTree();
  } catch (e) {
    toast.error(errMsg(e, '삭제하지 못했습니다'));
  } finally {
    busy.value = false;
  }
}

// ── 코드 인라인 등록·편집 ───────────────────────────────────────
const draft = reactive({ code: '', codeNm: '', sortOrder: '' });
const toBody = (
  d: { code: string; codeNm: string; sortOrder: string },
  isActive = true,
): CodeBody => ({
  code: d.code.trim(),
  codeNm: d.codeNm.trim(),
  sortOrder: d.sortOrder.trim() === '' ? null : Number(d.sortOrder),
  isActive,
});
const dupDraft = computed(() =>
  (detail.value?.codes ?? []).some((x) => x.code === draft.code.trim()),
);
async function addCode(): Promise<void> {
  const d = detail.value;
  if (!d || !draft.code.trim() || !draft.codeNm.trim() || dupDraft.value) return;
  busy.value = true;
  try {
    await api.createCode(key.value, d.codeCls.codeClsId, toBody(draft));
    toast.success(`코드 ${draft.code} ${draft.codeNm} 추가했습니다`);
    Object.assign(draft, { code: '', codeNm: '', sortOrder: String(d.codes.length + 2) });
    await Promise.all([loadDetail(), loadTree()]);
  } catch (e) {
    toast.error(errMsg(e, '추가하지 못했습니다'));
  } finally {
    busy.value = false;
  }
}
const editingCode = ref<number | null>(null);
const edit = reactive({ code: '', codeNm: '', sortOrder: '' });
function startEditCode(x: CodeItem): void {
  editingCode.value = x.codeId;
  Object.assign(edit, {
    code: x.code,
    codeNm: x.codeNm,
    sortOrder: x.sortOrder === null ? '' : String(x.sortOrder),
  });
}
async function saveCode(x: CodeItem, isActive = x.isActive): Promise<void> {
  busy.value = true;
  try {
    const body =
      editingCode.value === x.codeId
        ? toBody(edit, isActive)
        : { code: x.code, codeNm: x.codeNm, sortOrder: x.sortOrder, isActive };
    await api.updateCode(key.value, x.codeClsId, x.codeId, body);
    editingCode.value = null;
    await Promise.all([loadDetail(), loadTree()]);
  } catch (e) {
    toast.error(errMsg(e, '저장하지 못했습니다'));
  } finally {
    busy.value = false;
  }
}
const deletingCode = ref<CodeItem | null>(null);
async function removeCode(): Promise<void> {
  const x = deletingCode.value;
  if (!x) return;
  busy.value = true;
  try {
    await api.deleteCode(key.value, x.codeClsId, x.codeId);
    toast.success(`코드 ${x.code} 삭제했습니다`);
    deletingCode.value = null;
    await Promise.all([loadDetail(), loadTree()]);
  } catch (e) {
    toast.error(errMsg(e, '삭제하지 못했습니다'));
  } finally {
    busy.value = false;
  }
}
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
          ><span>›</span><span>표준 사전</span><span>›</span><span>코드</span>
        </div>
        <h1 class="page-title">
          코드 <span class="count-pill">{{ fmtNum(totals.code) }}</span>
        </h1>
        <p class="page-desc">
          업무구분 › 코드구분 › 코드 3계층. 업무구분은
          <RouterLink :to="`/projects/${key}/biz-areas`">프로젝트 › 업무구분</RouterLink> 마스터를
          따르며, 코드구분은 업무구분에 속합니다(C4). 편집기에서 논리명이 '…코드'로 끝나면 코드구분
          후보가 함께 나옵니다(S6).
        </p>
      </div>
      <div v-if="canWrite" class="page-actions">
        <RouterLink class="btn btn-secondary" :to="`/projects/${key}/standards/code-classes/import`"
          ><TfIcon name="upload" />엑셀 업로드</RouterLink
        >
      </div>
    </div>

    <div class="split">
      <div class="card card-flush">
        <div class="card-header">
          <div class="card-title"><TfIcon name="folder" />프로젝트의 업무구분</div>
        </div>
        <div class="stack-sm card-pad">
          <SearchBox
            v-model="treeQ"
            label="코드구분 검색"
            placeholder="코드구분 · 코드 검색"
            width=""
          />
          <TfSkeleton v-if="treeLoading && !bizAreas.length" :lines="6" />
          <div class="tree" role="tree" aria-label="업무구분 · 코드구분">
            <template v-for="b in bizAreas" :key="b.bizAreaId">
              <div
                class="tree-node"
                role="treeitem"
                :aria-expanded="!!expanded[b.bizAreaId]"
                tabindex="0"
                @click="expanded[b.bizAreaId] = !expanded[b.bizAreaId]"
                @keydown.enter="expanded[b.bizAreaId] = !expanded[b.bizAreaId]"
              >
                <TfIcon
                  :name="expanded[b.bizAreaId] ? 'chevron-down' : 'chevron-right'"
                  size="sm"
                />
                <span class="tree-key">{{ b.bizCd }}</span
                >{{ b.bizNm }}
                <span v-if="!b.useYn" class="badge badge-gray">사용 중지</span>
                <span class="tree-count">{{ byBiz.get(b.bizAreaId)?.length ?? 0 }}</span>
                <button
                  v-if="canWrite && b.useYn"
                  class="btn btn-ghost btn-sm btn-icon"
                  type="button"
                  :aria-label="`${b.bizCd}에 코드구분 추가`"
                  :title="`${b.bizCd}에 코드구분 추가`"
                  @click.stop="openAddCls(b)"
                >
                  <TfIcon name="plus" size="sm" />
                </button>
              </div>
              <div v-if="expanded[b.bizAreaId]" class="tree-children">
                <div
                  v-if="addFor === b.bizAreaId"
                  class="row"
                  @keydown.enter.prevent="addCls"
                  @keydown.esc="addFor = null"
                >
                  <input
                    v-model="newCls.codeCls"
                    class="input input-sm mono w-80"
                    aria-label="새 코드구분"
                    placeholder="010"
                    maxlength="10"
                  />
                  <input
                    v-model="newCls.codeClsNm"
                    class="input input-sm"
                    aria-label="새 코드구분명"
                    placeholder="코드구분명"
                    maxlength="100"
                  />
                  <TfButton variant="primary" size="sm" :loading="busy" @click="addCls"
                    >추가</TfButton
                  >
                </div>
                <div
                  v-for="c in byBiz.get(b.bizAreaId) ?? []"
                  :key="c.codeClsId"
                  :class="['tree-node', { 'is-active': c.codeClsId === selectedId }]"
                  role="treeitem"
                  :aria-selected="c.codeClsId === selectedId"
                  tabindex="0"
                  @click="select(c)"
                  @keydown.enter="select(c)"
                >
                  <span class="tree-key">{{ c.codeCls }}</span
                  >{{ c.codeClsNm }}
                  <span class="tree-count">{{ c.codeCnt }}</span>
                </div>
                <div
                  v-if="!byBiz.get(b.bizAreaId)?.length && addFor !== b.bizAreaId"
                  class="tree-node text-muted"
                >
                  코드구분 없음
                </div>
              </div>
            </template>
          </div>
        </div>
        <div class="table-footer">
          업무구분 {{ bizAreas.length }} · 코드구분 {{ fmtNum(totals.cls) }} · 코드
          {{ fmtNum(totals.code) }}
        </div>
      </div>

      <div class="stack">
        <EmptyState
          v-if="!detail"
          icon="code"
          title="코드구분을 고르세요"
          desc="왼쪽 업무구분을 펼쳐 코드구분을 선택하면 코드를 보고 편집할 수 있습니다."
        />
        <template v-else>
          <div class="card" data-testid="cls-card">
            <div class="row wrap">
              <span class="badge badge-accent mono badge-lg"
                >{{ detail.codeCls.bizCd }}/{{ detail.codeCls.codeCls }}</span
              >
              <template v-if="renaming">
                <input
                  v-model="rename.codeCls"
                  class="input input-sm mono w-80"
                  aria-label="코드구분"
                />
                <input
                  v-model="rename.codeClsNm"
                  class="input input-sm"
                  aria-label="코드구분명"
                  @keydown.enter="saveRename"
                />
                <TfButton variant="primary" size="sm" :loading="busy" @click="saveRename"
                  >저장</TfButton
                >
                <TfButton variant="ghost" size="sm" @click="renaming = false">취소</TfButton>
              </template>
              <template v-else>
                <span class="fw-600">{{ detail.codeCls.codeClsNm }}</span>
                <span class="text-muted text-sm"
                  >업무구분 {{ detail.codeCls.bizCd }} {{ detail.codeCls.bizNm }} · 코드
                  {{ detail.codeCls.codeCnt }}</span
                >
              </template>
              <span class="spacer" />
              <span class="text-sm text-muted"
                >이 코드구분을 쓰는 컬럼 {{ detail.codeCls.columnCnt
                }}<template v-if="detail.columnSamples.length">
                  — <span class="mono">{{ detail.columnSamples.join(', ') }}</span></template
                ></span
              >
              <template v-if="canWrite && !renaming">
                <TfButton variant="ghost" size="sm" icon="edit" @click="startRename"
                  >이름 변경</TfButton
                >
                <TfButton variant="danger-ghost" size="sm" icon="trash" @click="deletingCls = true"
                  >삭제</TfButton
                >
              </template>
            </div>
            <div class="text-sm text-muted mt-2">
              DDL 코멘트 요약(D14): <span class="mono">{{ summary }}</span>
            </div>
          </div>

          <div class="toolbar">
            <SearchBox
              v-model="codeQ"
              label="코드 검색"
              placeholder="코드 · 코드명 검색"
              width="w-240"
            />
            <label class="row text-sm"
              ><TfToggle v-model="includeInactive" aria-label="사용 안 함 포함" />사용 안 함
              포함</label
            >
          </div>
          <div class="table-wrap">
            <table class="table">
              <caption class="sr-only">
                코드 목록
              </caption>
              <thead>
                <tr>
                  <th>코드</th>
                  <th>코드명</th>
                  <th class="num">정렬</th>
                  <th>사용</th>
                  <th class="col-menu" />
                </tr>
              </thead>
              <tbody>
                <template v-if="canWrite">
                  <tr class="is-inline-new" @keydown.enter.prevent="addCode">
                    <td>
                      <input
                        v-model="draft.code"
                        :class="['input', 'mono', 'w-100', { 'is-invalid': dupDraft }]"
                        aria-label="코드"
                        maxlength="10"
                      />
                    </td>
                    <td>
                      <input
                        v-model="draft.codeNm"
                        class="input"
                        aria-label="코드명"
                        maxlength="100"
                      />
                    </td>
                    <td>
                      <input v-model="draft.sortOrder" class="input w-80 num" aria-label="정렬" />
                    </td>
                    <td colspan="2" class="nowrap">
                      <TfButton
                        variant="primary"
                        size="sm"
                        kbd="Enter"
                        :disabled="!draft.code.trim() || !draft.codeNm.trim() || dupDraft"
                        :loading="busy"
                        @click="addCode"
                        >추가</TfButton
                      >
                      <span v-if="dupDraft" class="text-danger text-sm"> 같은 코드가 있습니다</span>
                    </td>
                  </tr>
                </template>
                <template v-for="x in codes" :key="x.codeId">
                  <tr
                    v-if="editingCode === x.codeId"
                    class="is-editing"
                    @keydown.enter.prevent="saveCode(x)"
                    @keydown.esc="editingCode = null"
                  >
                    <td>
                      <input v-model="edit.code" class="input mono w-100" aria-label="코드" />
                    </td>
                    <td><input v-model="edit.codeNm" class="input" aria-label="코드명" /></td>
                    <td>
                      <input v-model="edit.sortOrder" class="input w-80 num" aria-label="정렬" />
                    </td>
                    <td colspan="2" class="nowrap">
                      <TfButton
                        variant="primary"
                        size="sm"
                        kbd="Enter"
                        :loading="busy"
                        @click="saveCode(x)"
                        >저장</TfButton
                      >
                      {{ ' '
                      }}<TfButton variant="ghost" size="sm" kbd="Esc" @click="editingCode = null"
                        >취소</TfButton
                      >
                    </td>
                  </tr>
                  <tr v-else :class="{ 'is-disabled': !x.isActive }">
                    <td class="mono fw-600">{{ x.code }}</td>
                    <td>{{ x.codeNm }}</td>
                    <td class="num">{{ x.sortOrder ?? '—' }}</td>
                    <td>
                      <TfToggle
                        :model-value="x.isActive"
                        :aria-label="`${x.code} 사용`"
                        :disabled="!canWrite"
                        @update:model-value="(v: boolean) => saveCode(x, v)"
                      />
                    </td>
                    <td class="col-menu nowrap">
                      <template v-if="canWrite">
                        <TfButton
                          variant="ghost"
                          size="sm"
                          icon-only
                          icon="edit"
                          :aria-label="`${x.code} 수정`"
                          @click="startEditCode(x)"
                        />
                        <TfButton
                          variant="ghost"
                          size="sm"
                          icon-only
                          icon="trash"
                          :aria-label="`${x.code} 삭제`"
                          @click="deletingCode = x"
                        />
                      </template>
                    </td>
                  </tr>
                </template>
                <tr v-if="codes.length === 0">
                  <td colspan="5"><EmptyState in-table icon="code" title="코드가 없습니다" /></td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>
    </div>

    <ConfirmDeleteModal
      :open="deletingCls && detail !== null"
      :title="`코드구분 ${detail?.codeCls.bizCd}/${detail?.codeCls.codeCls} ${detail?.codeCls.codeClsNm}을(를) 삭제할까요?`"
      :busy="busy"
      @cancel="deletingCls = false"
      @confirm="removeCls"
    >
      소속 코드 <strong>{{ detail?.codeCls.codeCnt }}</strong
      >개가 함께 삭제됩니다.
      <template v-if="detail && detail.codeCls.columnCnt > 0">
        이 코드구분을 쓰는 컬럼 <strong>{{ detail.codeCls.columnCnt }}</strong
        >개는 연결이 해제되고 '코드구분 삭제됨' 경고가 표시됩니다.
      </template>
    </ConfirmDeleteModal>
    <ConfirmDeleteModal
      :open="deletingCode !== null"
      :title="`코드 ${deletingCode?.code} ${deletingCode?.codeNm}을(를) 삭제할까요?`"
      :busy="busy"
      @cancel="deletingCode = null"
      @confirm="removeCode"
    >
      폐기한 코드는 삭제 대신 '사용' 끄기를 권장합니다(DDL 코멘트 요약에서만 빠짐, D14).
    </ConfirmDeleteModal>
  </template>
</template>
