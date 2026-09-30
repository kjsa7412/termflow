<script setup lang="ts">
import { ref } from 'vue';
import type { CodeClsItem } from '@termflow/shared';
import { standardsApi } from '../../api/standards.js';
import { useEditorStore, type EditorRow } from '../../stores/editor.js';
import TfIcon from '../ui/TfIcon.vue';
import TfPopover from '../ui/TfPopover.vue';

/**
 * 행 '코드' 아이콘 → 코드구분 인라인 검색 팝오버(설계서 §5.6 "논리명이 '코드'로 끝나지 않아도", 목업 08 `.code-chip`·`.code-add`).
 * `GET P/standards/code-classes?q=` 결과를 고르면 code_cls_id·match_type CODE를 설정한다. 모달이 아니다(G9).
 */
const props = defineProps<{ row: EditorRow; readOnly: boolean; rowNo: number }>();
const ed = useEditorStore();
const sapi = standardsApi();
const q = ref('');
const items = ref<CodeClsItem[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;

async function search(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const r = await sapi.codeClasses(ed.projectKey, { q: q.value.trim() || undefined, size: 20 });
    items.value = r.items;
  } catch {
    error.value = '코드구분을 불러오지 못했습니다';
  } finally {
    loading.value = false;
  }
}
function onInput(e: Event): void {
  q.value = (e.target as HTMLInputElement).value;
  clearTimeout(timer);
  timer = setTimeout(() => void search(), 250);
}
function open(toggle: () => void, isOpen: boolean): void {
  toggle();
  if (!isOpen) {
    q.value = props.row.logicalNm.replace(/코드$/, '');
    void search();
  }
}
function pick(c: CodeClsItem, close: () => void): void {
  ed.setCodeCls(props.row.uid, {
    codeClsId: c.codeClsId,
    bizCd: c.bizCd,
    codeCls: c.codeCls,
    codeClsNm: c.codeClsNm,
  });
  close();
}
const label = () =>
  props.row.codeCls
    ? `${props.row.codeCls.bizCd}/${props.row.codeCls.codeCls} ${props.row.codeCls.codeClsNm}`
    : props.row.codeClsId !== null
      ? `#${props.row.codeClsId}`
      : null;
</script>

<template>
  <span v-if="readOnly || row.defaultColId !== null">
    <span v-if="label()" class="code-chip" :title="label() ?? ''"
      ><TfIcon name="code" size="sm" /><span>{{ label() }}</span></span
    >
    <span v-else class="cell-text text-muted">—</span>
  </span>
  <TfPopover v-else popover>
    <template #trigger="{ toggle, open: isOpen, menuId }">
      <button
        :class="label() ? 'code-chip' : 'code-add'"
        type="button"
        :title="label() ? `코드구분 변경 · ${label()}` : '코드구분 선택'"
        :aria-label="`${rowNo}행 코드구분 ${label() ? `변경(${label()})` : '선택'}`"
        aria-haspopup="dialog"
        :aria-expanded="isOpen"
        :aria-controls="menuId"
        data-testid="code-picker"
        @click="open(toggle, isOpen)"
      >
        <TfIcon name="code" size="sm" /><span>{{ label() ?? '코드 선택' }}</span>
      </button>
    </template>
    <template #default="{ close }">
      <div class="popover-body code-pop">
        <input
          class="input input-sm"
          :value="q"
          placeholder="코드구분명·코드구분 검색"
          aria-label="코드구분 검색"
          @input="onInput"
          @keydown.enter.prevent="search"
        />
        <div v-if="loading" class="text-sm text-muted mt-2"><span class="spinner" /> 검색 중</div>
        <div v-else-if="error" class="text-sm text-danger mt-2" role="alert">{{ error }}</div>
        <div v-else-if="items.length === 0" class="text-sm text-muted mt-2">결과가 없습니다</div>
        <button
          v-for="c in items"
          :key="c.codeClsId"
          class="dropdown-item"
          type="button"
          @click="pick(c, close)"
        >
          <span class="badge badge-accent mono">{{ c.bizCd }}/{{ c.codeCls }}</span
          >{{ c.codeClsNm }} <span class="text-muted">· 코드 {{ c.codeCnt }}</span>
        </button>
        <template v-if="row.codeClsId !== null">
          <div class="dropdown-sep" />
          <button
            class="dropdown-item is-danger"
            type="button"
            @click="(ed.setCodeCls(row.uid, null), close())"
          >
            <TfIcon name="x" />코드구분 연결 해제
          </button>
        </template>
      </div>
    </template>
  </TfPopover>
</template>
