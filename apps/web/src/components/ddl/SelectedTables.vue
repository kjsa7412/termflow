<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { BizAreaItem, TableListItem } from '@termflow/shared';
import { tablesApi } from '../../api/tables.js';
import TfBadge from '../ui/TfBadge.vue';
import TfIcon from '../ui/TfIcon.vue';
import TfPopover from '../ui/TfPopover.vue';
import type { SelItem } from './types.js';

/**
 * 선택 테이블 목록: ↑↓ 순서 변경(드래그 대신 키보드로도 되는 버튼) · 제외 · [업무구분 추가](다중 선택, CR-01) · [테이블 추가](검색).
 */
const items = defineModel<SelItem[]>({ required: true });
const props = defineProps<{ projectKey: string; bizAreas: readonly BizAreaItem[] }>();
const emit = defineEmits<{ addBiz: [ids: number[]] }>();
const api = tablesApi();

function move(i: number, d: -1 | 1): void {
  const j = i + d;
  if (j < 0 || j >= items.value.length) return;
  const next = [...items.value];
  [next[i], next[j]] = [next[j]!, next[i]!];
  items.value = next;
}
function remove(id: number): void {
  items.value = items.value.filter((t) => t.tableId !== id);
}
const totalCols = computed(() => items.value.reduce((n, t) => n + t.colCnt, 0));

// 테이블 검색 추가
const q = ref('');
const found = ref<TableListItem[]>([]);
let timer: ReturnType<typeof setTimeout> | null = null;
async function search(): Promise<void> {
  try {
    found.value = (
      await api.tables(props.projectKey, {
        q: q.value.trim() || undefined,
        size: 10,
        sort: 'tableNm,asc',
      })
    ).items;
  } catch {
    found.value = [];
  }
}
watch(q, () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void search(), 200);
});
function onOpenSearch(toggle: () => void): void {
  toggle();
  void search();
}
function add(t: TableListItem): void {
  if (items.value.some((x) => x.tableId === t.tableId)) return;
  items.value = [
    ...items.value,
    {
      tableId: t.tableId,
      tableNm: t.tableNm,
      logicalNm: t.logicalNm,
      colCnt: t.colCnt,
      status: t.status,
      bizCd: t.bizCd,
      warningCnt: t.warningCnt,
      errorCnt: t.errorCnt,
    },
  ];
}

// 업무구분 추가(다중)
const picked = ref<number[]>([]);
function togglePick(id: number): void {
  picked.value = picked.value.includes(id)
    ? picked.value.filter((x) => x !== id)
    : [...picked.value, id];
}
function addBiz(close: () => void): void {
  if (picked.value.length === 0) return;
  emit('addBiz', [...picked.value]);
  picked.value = [];
  close();
}
</script>

<template>
  <div class="card card-flush" data-testid="selected-tables">
    <div class="card-header">
      <div class="card-title nowrap">
        선택 테이블 <span class="count-pill">{{ items.length }}</span>
      </div>
      <div class="row">
        <TfPopover align="right" popover>
          <template #trigger="{ toggle, open, menuId }">
            <button
              class="btn btn-ghost btn-sm"
              type="button"
              aria-haspopup="dialog"
              :aria-expanded="open"
              :aria-controls="menuId"
              @click="toggle"
            >
              <TfIcon name="folder" />업무구분
            </button>
          </template>
          <template #default="{ close }">
            <div class="popover-title">업무구분의 테이블 추가</div>
            <div class="stack-sm">
              <label v-for="b in bizAreas" :key="b.bizAreaId" class="check">
                <input
                  type="checkbox"
                  :checked="picked.includes(b.bizAreaId)"
                  :disabled="b.tableCnt === 0"
                  @change="togglePick(b.bizAreaId)"
                /><span class="check-box" /><span class="mono">{{ b.bizCd }}</span> {{ b.bizNm }}
                <span class="text-muted">{{ b.tableCnt }}</span>
              </label>
            </div>
            <button
              class="btn btn-primary btn-sm mt-2"
              type="button"
              :disabled="picked.length === 0"
              @click="addBiz(close)"
            >
              추가
            </button>
          </template>
        </TfPopover>
        <TfPopover align="right" popover>
          <template #trigger="{ toggle, open, menuId }">
            <button
              class="btn btn-ghost btn-sm"
              type="button"
              aria-haspopup="dialog"
              :aria-expanded="open"
              :aria-controls="menuId"
              @click="onOpenSearch(toggle)"
            >
              <TfIcon name="plus" />추가
            </button>
          </template>
          <template #default>
            <div class="input-wrap mb-2">
              <TfIcon name="search" /><input
                v-model="q"
                class="input input-sm"
                placeholder="테이블 검색"
                aria-label="추가할 테이블 검색"
              />
            </div>
            <button
              v-for="t in found"
              :key="t.tableId"
              class="dropdown-item"
              type="button"
              :disabled="items.some((x) => x.tableId === t.tableId)"
              @click="add(t)"
            >
              <span class="mono">{{ t.tableNm }}</span
              ><span class="dropdown-meta">{{ t.logicalNm }}</span>
            </button>
            <div v-if="found.length === 0" class="dropdown-item is-disabled">결과 없음</div>
          </template>
        </TfPopover>
      </div>
    </div>
    <table v-if="items.length > 0" class="table table-compact">
      <caption class="sr-only">
        선택 테이블(생성 순서)
      </caption>
      <tbody>
        <tr v-for="(t, i) in items" :key="t.tableId">
          <td class="col-check nowrap">
            <button
              class="btn btn-ghost btn-sm btn-icon"
              type="button"
              :disabled="i === 0"
              :aria-label="`${t.tableNm} 위로`"
              @click="move(i, -1)"
            >
              ↑
            </button>
            <button
              class="btn btn-ghost btn-sm btn-icon"
              type="button"
              :disabled="i === items.length - 1"
              :aria-label="`${t.tableNm} 아래로`"
              @click="move(i, 1)"
            >
              ↓
            </button>
          </td>
          <td>
            <span class="mono">{{ t.tableNm }}</span>
            <span class="sub"
              >{{ t.logicalNm }} · {{ t.colCnt }}열
              <TfBadge v-if="t.status" :kind="t.status === 'FINAL' ? 'final' : 'draft'">{{
                t.status
              }}</TfBadge>
              <TfBadge v-if="t.errorCnt" kind="danger">오류 {{ t.errorCnt }}</TfBadge>
              <TfBadge v-else-if="t.warningCnt" kind="warning">경고 {{ t.warningCnt }}</TfBadge>
            </span>
          </td>
          <td class="col-menu">
            <button
              class="btn btn-ghost btn-sm btn-icon"
              type="button"
              :title="`${t.tableNm} 제외`"
              :aria-label="`${t.tableNm} 제외`"
              @click="remove(t.tableId)"
            >
              <TfIcon name="x" />
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    <div class="table-footer">
      순서 = 파일 안 순서(↑↓로 변경) · 총 {{ totalCols.toLocaleString('ko-KR') }}열 · 1회 최대 200개
    </div>
  </div>
</template>
