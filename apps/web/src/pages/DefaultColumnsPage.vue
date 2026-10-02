<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import {
  checkStdTypeParts,
  IDENTIFIER_RE,
  STD_TYPES,
  stdTypeProblemIssue,
  typeText,
  type DefaultColSetItem,
  type StdType,
} from '@termflow/shared';
import { standardsApi, type DefaultColBody } from '../api/standards.js';
import ConfirmDeleteModal from '../components/ui/ConfirmDeleteModal.vue';
import EmptyState from '../components/ui/EmptyState.vue';
import TfButton from '../components/ui/TfButton.vue';
import TfIcon from '../components/ui/TfIcon.vue';
import TfSkeleton from '../components/ui/TfSkeleton.vue';
import { errMsg, fmtTs, useProject } from '../composables/useProject.js';
import { useToastStore } from '../stores/toast.js';

/**
 * 기본컬럼(`/projects/{key}/standards/default-columns`, 목업 없음 — 용어 화면 패턴, §14.0 목업 보완·§3.5.10): 세트 선택,
 * 컬럼 그리드(순서·PK·타입·NULL·기본값·코멘트) 편집 후 [저장](전체 교체, 기존 행 ID 유지), 기본 세트 지정(프로젝트당 1개).
 */
const { key, project, canWrite } = useProject();
const api = standardsApi();
const toast = useToastStore();
const sets = ref<DefaultColSetItem[]>([]);
const loaded = ref(false);
const notFound = ref(false);
const selectedId = ref<number | null>(null);
const busy = ref(false);

interface Row {
  defaultColId: number | null;
  logicalNm: string;
  physicalNm: string;
  isPk: boolean;
  dataType: StdType;
  dataLength: string;
  dataScale: string;
  isNullable: boolean;
  defaultVal: string;
  colComment: string;
}
const rows = ref<Row[]>([]);
const baseline = ref('');
const selected = computed(() => sets.value.find((s) => s.setId === selectedId.value) ?? null);

function toRows(s: DefaultColSetItem | null): Row[] {
  return (s?.columns ?? []).map((c) => ({
    defaultColId: c.defaultColId,
    logicalNm: c.logicalNm,
    physicalNm: c.physicalNm,
    isPk: c.isPk,
    dataType: c.dataType,
    dataLength: c.dataLength === null ? '' : String(c.dataLength),
    dataScale: c.dataScale === null ? '' : String(c.dataScale),
    isNullable: c.isNullable,
    defaultVal: c.defaultVal ?? '',
    colComment: c.colComment ?? '',
  }));
}
function useSet(s: DefaultColSetItem | null): void {
  selectedId.value = s?.setId ?? null;
  rows.value = toRows(s);
  baseline.value = JSON.stringify(rows.value);
}
async function load(pick?: number): Promise<void> {
  try {
    sets.value = await api.defaultColSets(key.value);
    notFound.value = false;
    const target =
      sets.value.find((s) => s.setId === (pick ?? selectedId.value)) ??
      sets.value.find((s) => s.isDefault) ??
      sets.value[0] ??
      null;
    useSet(target);
  } catch (e) {
    notFound.value = (e as { status?: number }).status === 404;
  } finally {
    loaded.value = true;
  }
}
watch(key, () => void load(), { immediate: true });
const dirty = computed(() => JSON.stringify(rows.value) !== baseline.value);

const num = (v: string) => (v.trim() === '' ? null : Number(v));
function rowIssue(r: Row, i: number): string | null {
  if (!r.logicalNm.trim()) return '논리명을 입력하세요';
  if (!IDENTIFIER_RE.test(r.physicalNm)) return '물리명은 영대문자로 시작, 영대문자·숫자·_만';
  if (rows.value.findIndex((x) => x.physicalNm === r.physicalNm) !== i)
    return '세트 안에 같은 물리명이 있습니다';
  const p = checkStdTypeParts(r.dataType, num(r.dataLength), num(r.dataScale));
  return p ? stdTypeProblemIssue(p, r.dataType).message : null;
}
const issues = computed(() => rows.value.map((r, i) => rowIssue(r, i)));
const errorCnt = computed(() => issues.value.filter(Boolean).length);

function addRow(): void {
  rows.value.push({
    defaultColId: null,
    logicalNm: '',
    physicalNm: '',
    isPk: false,
    dataType: 'VARCHAR',
    dataLength: '20',
    dataScale: '',
    isNullable: true,
    defaultVal: '',
    colComment: '',
  });
}
function move(i: number, d: -1 | 1): void {
  const j = i + d;
  if (j < 0 || j >= rows.value.length) return;
  const list = [...rows.value];
  [list[i], list[j]] = [list[j]!, list[i]!];
  rows.value = list;
}
function onPk(r: Row): void {
  if (r.isPk) r.isNullable = false;
}
async function save(): Promise<void> {
  if (!selected.value || errorCnt.value > 0) return;
  busy.value = true;
  try {
    const cols: DefaultColBody[] = rows.value.map((r) => ({
      defaultColId: r.defaultColId,
      logicalNm: r.logicalNm.trim(),
      physicalNm: r.physicalNm.trim(),
      isPk: r.isPk,
      dataType: r.dataType,
      dataLength: num(r.dataLength),
      dataScale: num(r.dataScale),
      isNullable: r.isPk ? false : r.isNullable,
      defaultVal: r.defaultVal.trim() || null,
      colComment: r.colComment.trim() || null,
    }));
    const s = await api.putDefaultCols(key.value, selected.value.setId, cols);
    toast.success(`기본컬럼 세트 '${s.setNm}' ${s.colCnt}개 저장했습니다`);
    await load(s.setId);
  } catch (e) {
    toast.error(errMsg(e, '저장하지 못했습니다'));
  } finally {
    busy.value = false;
  }
}

// ── 세트 추가·이름·기본·삭제 ──────────────────────────────────
const naming = ref<'new' | 'rename' | null>(null);
const setNm = ref('');
function openName(mode: 'new' | 'rename'): void {
  naming.value = mode;
  setNm.value = mode === 'rename' ? (selected.value?.setNm ?? '') : '';
}
async function saveName(): Promise<void> {
  const nm = setNm.value.trim();
  if (!nm) return;
  busy.value = true;
  try {
    const s =
      naming.value === 'new'
        ? await api.createDefaultColSet(key.value, { setNm: nm, description: null })
        : await api.updateDefaultColSet(key.value, selected.value!.setId, {
            setNm: nm,
            description: selected.value!.description,
          });
    toast.success(`세트 '${s.setNm}' 저장했습니다`);
    naming.value = null;
    await load(s.setId);
  } catch (e) {
    toast.error(errMsg(e, '저장하지 못했습니다'));
  } finally {
    busy.value = false;
  }
}
async function makeDefault(): Promise<void> {
  if (!selected.value) return;
  busy.value = true;
  try {
    const s = await api.setDefaultColSet(key.value, selected.value.setId);
    toast.success(`'${s.setNm}'을(를) 기본 세트로 지정했습니다(새 테이블에 자동 포함)`);
    await load(s.setId);
  } catch (e) {
    toast.error(errMsg(e, '지정하지 못했습니다'));
  } finally {
    busy.value = false;
  }
}
const deleting = ref(false);
async function remove(): Promise<void> {
  if (!selected.value) return;
  busy.value = true;
  try {
    await api.deleteDefaultColSet(key.value, selected.value.setId);
    toast.success(`세트 '${selected.value.setNm}' 삭제했습니다`);
    deleting.value = false;
    selectedId.value = null;
    await load();
  } catch (e) {
    toast.error(errMsg(e, '삭제하지 못했습니다'));
    deleting.value = false;
  } finally {
    busy.value = false;
  }
}
const typeOf = (r: Row) => typeText(r.dataType, num(r.dataLength), num(r.dataScale));
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
          ><span>›</span><span>표준 사전</span><span>›</span><span>기본컬럼</span>
        </div>
        <h1 class="page-title">
          기본컬럼 <span class="count-pill">{{ sets.length }}</span>
        </h1>
        <p class="page-desc">
          새 테이블에 자동으로 들어가는 공통 컬럼(등록·수정 일시·사용자 등) 세트입니다. 프로젝트마다
          기본 세트가 하나이며, 편집기의 하단 '기본컬럼' 영역이 이 세트를 씁니다.
          {{ canWrite ? '' : '프로젝트 관리자만 편집할 수 있습니다.' }}
        </p>
      </div>
      <div v-if="canWrite" class="page-actions">
        <TfButton variant="secondary" icon="plus" @click="openName('new')">새 세트</TfButton>
      </div>
    </div>

    <TfSkeleton v-if="!loaded" :lines="6" />
    <template v-else>
      <div class="toolbar">
        <div class="seg" role="tablist" aria-label="기본컬럼 세트">
          <button
            v-for="s in sets"
            :key="s.setId"
            type="button"
            role="tab"
            :aria-selected="s.setId === selectedId"
            :class="{ 'is-active': s.setId === selectedId }"
            @click="useSet(s)"
          >
            {{ s.setNm }} <span v-if="s.isDefault" class="count">기본</span>
            <span class="count">{{ s.colCnt }}</span>
          </button>
        </div>
        <template v-if="naming">
          <input
            v-model="setNm"
            class="input w-160"
            :aria-label="naming === 'new' ? '새 세트 이름' : '세트 이름'"
            maxlength="50"
            @keydown.enter="saveName"
            @keydown.esc="naming = null"
          />
          <TfButton variant="primary" size="sm" :loading="busy" @click="saveName">저장</TfButton>
          <TfButton variant="ghost" size="sm" @click="naming = null">취소</TfButton>
        </template>
        <span class="spacer" />
        <template v-if="canWrite && selected && !naming">
          <TfButton variant="ghost" size="sm" icon="edit" @click="openName('rename')"
            >이름 변경</TfButton
          >
          <TfButton
            v-if="!selected.isDefault"
            variant="ghost"
            size="sm"
            icon="check"
            :loading="busy"
            @click="makeDefault"
            >기본 세트로 지정</TfButton
          >
          <TfButton variant="danger-ghost" size="sm" icon="trash" @click="deleting = true"
            >세트 삭제</TfButton
          >
        </template>
      </div>

      <EmptyState
        v-if="!selected"
        icon="columns"
        title="기본컬럼 세트가 없습니다"
        desc="[새 세트]로 만들면 첫 세트가 기본 세트가 됩니다."
      />
      <template v-else>
        <div class="table-wrap">
          <table class="table table-compact table-dense">
            <caption class="sr-only">
              기본컬럼 구성
            </caption>
            <thead>
              <tr>
                <th class="num shrink">순서</th>
                <th class="shrink">PK</th>
                <th>논리명</th>
                <th>물리명</th>
                <th class="shrink">타입</th>
                <th class="num shrink">길이</th>
                <th class="num shrink">스케일</th>
                <th class="shrink">NULL</th>
                <th>기본값</th>
                <th>코멘트</th>
                <th class="col-menu" />
              </tr>
            </thead>
            <tbody>
              <template v-for="(r, i) in rows" :key="r.defaultColId ?? `new-${i}`">
                <tr :class="{ 'is-inline-new': r.defaultColId === null }">
                  <td class="num nowrap">
                    {{ i + 1 }}
                    <template v-if="canWrite">
                      <button
                        class="btn btn-ghost btn-sm btn-icon"
                        type="button"
                        :aria-label="`${i + 1}행 위로`"
                        :disabled="i === 0"
                        @click="move(i, -1)"
                      >
                        ↑
                      </button>
                      <button
                        class="btn btn-ghost btn-sm btn-icon"
                        type="button"
                        :aria-label="`${i + 1}행 아래로`"
                        :disabled="i === rows.length - 1"
                        @click="move(i, 1)"
                      >
                        ↓
                      </button>
                    </template>
                  </td>
                  <td>
                    <label class="check"
                      ><input
                        v-model="r.isPk"
                        type="checkbox"
                        :disabled="!canWrite"
                        :aria-label="`${i + 1}행 PK`"
                        @change="onPk(r)" /><span class="check-box"
                    /></label>
                  </td>
                  <td>
                    <input
                      v-model="r.logicalNm"
                      class="input input-sm"
                      :readonly="!canWrite"
                      :aria-label="`${i + 1}행 논리명`"
                    />
                  </td>
                  <td>
                    <input
                      v-model="r.physicalNm"
                      :class="['input', 'input-sm', 'mono', { 'is-invalid': !!issues[i] }]"
                      :readonly="!canWrite"
                      :aria-label="`${i + 1}행 물리명`"
                      @input="r.physicalNm = r.physicalNm.toUpperCase()"
                    />
                  </td>
                  <td>
                    <select
                      v-model="r.dataType"
                      class="select select-sm w-120"
                      :disabled="!canWrite"
                      :aria-label="`${i + 1}행 타입`"
                    >
                      <option v-for="t in STD_TYPES" :key="t" :value="t">{{ t }}</option>
                    </select>
                  </td>
                  <td>
                    <input
                      v-model="r.dataLength"
                      class="input input-sm w-80 num"
                      :readonly="!canWrite"
                      :aria-label="`${i + 1}행 길이`"
                    />
                  </td>
                  <td>
                    <input
                      v-model="r.dataScale"
                      class="input input-sm w-80 num"
                      :readonly="!canWrite"
                      :aria-label="`${i + 1}행 스케일`"
                    />
                  </td>
                  <td>
                    <label class="check"
                      ><input
                        v-model="r.isNullable"
                        type="checkbox"
                        :disabled="!canWrite || r.isPk"
                        :aria-label="`${i + 1}행 NULL 허용`" /><span class="check-box"
                    /></label>
                  </td>
                  <td>
                    <input
                      v-model="r.defaultVal"
                      class="input input-sm mono"
                      :readonly="!canWrite"
                      :aria-label="`${i + 1}행 기본값`"
                    />
                  </td>
                  <td>
                    <input
                      v-model="r.colComment"
                      class="input input-sm"
                      :readonly="!canWrite"
                      :aria-label="`${i + 1}행 코멘트`"
                    />
                  </td>
                  <td class="col-menu">
                    <TfButton
                      v-if="canWrite"
                      variant="ghost"
                      size="sm"
                      icon-only
                      icon="trash"
                      :aria-label="`${i + 1}행 삭제`"
                      @click="rows.splice(i, 1)"
                    />
                  </td>
                </tr>
                <tr v-if="issues[i]" class="row-msg">
                  <td colspan="11">
                    <span class="text-sm text-danger"
                      ><TfIcon name="alert-circle" size="sm" /> {{ issues[i] }}</span
                    >
                    <span class="text-sm text-muted"> · 결과 타입 {{ typeOf(r) }}</span>
                  </td>
                </tr>
              </template>
              <tr v-if="rows.length === 0">
                <td colspan="11"><EmptyState in-table icon="columns" title="컬럼이 없습니다" /></td>
              </tr>
            </tbody>
          </table>
          <div class="table-footer">
            {{ selected.isDefault ? '기본 세트' : '보조 세트' }} · 테이블 컬럼 참조
            {{ selected.columnRefCnt }} · 수정 {{ selected.updatedBy }}
            {{ fmtTs(selected.updatedAt) }} · 행을 지우면 그 기본컬럼을 쓰던 테이블 컬럼의 연결이
            해제됩니다(값 유지)
          </div>
        </div>
        <div v-if="canWrite" class="row mt-4">
          <TfButton variant="ghost" icon="plus" @click="addRow">행 추가</TfButton>
          <span class="spacer" />
          <span v-if="errorCnt" class="text-sm text-danger">오류 {{ errorCnt }}건</span>
          <span v-else-if="dirty" class="text-sm text-muted">저장하지 않은 변경이 있습니다</span>
          <TfButton variant="ghost" :disabled="!dirty" @click="useSet(selected)">되돌리기</TfButton>
          <TfButton
            variant="primary"
            icon="save"
            :disabled="!dirty || errorCnt > 0"
            :loading="busy"
            @click="save"
            >저장</TfButton
          >
        </div>
      </template>
    </template>

    <ConfirmDeleteModal
      :open="deleting"
      :title="`기본컬럼 세트 '${selected?.setNm}'을(를) 삭제할까요?`"
      :busy="busy"
      @cancel="deleting = false"
      @confirm="remove"
    >
      <template v-if="selected?.isDefault && sets.length > 1">
        기본 세트입니다. 다른 세트를 먼저 기본으로 지정해야 삭제할 수 있습니다.
      </template>
      <template v-else>
        구성 컬럼 {{ selected?.colCnt }}개가 함께 삭제되고, 이를 쓰던 테이블 컬럼
        {{ selected?.columnRefCnt }}개의 연결이 해제됩니다.
      </template>
    </ConfirmDeleteModal>
  </template>
</template>
