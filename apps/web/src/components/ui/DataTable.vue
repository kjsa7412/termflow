<script setup lang="ts" generic="T extends Record<string, unknown>">
import { computed } from 'vue';
import { PAGE_SIZES, type Column, type Sort } from './data-table.js';
import TfSkeleton from './TfSkeleton.vue';

/**
 * 표(목업 §7, §10.3 목록 패턴): 정렬(머리글 클릭·Enter), 행 선택(전체 선택 포함), 페이지네이션(20/50/100).
 * 셀 내용은 `#cell-{key}` 슬롯(row 전달), 인라인 입력행은 `#prepend`, 빈 상태는 `#empty`.
 * 정렬·페이지는 v-model(`sort`, `page`, `size`)로 부모가 서버 조회에 쓴다. `localSort`면 표가 직접 정렬한다.
 */

const props = withDefaults(
  defineProps<{
    columns: readonly Column[];
    rows: readonly T[];
    rowKey: keyof T & string;
    selectable?: boolean;
    localSort?: boolean;
    total?: number;
    loading?: boolean;
    rowClass?: (row: T) => string | Record<string, boolean> | undefined;
    caption?: string;
    paginate?: boolean;
  }>(),
  { paginate: true },
);
const sort = defineModel<Sort | null>('sort', { default: null });
const selected = defineModel<(string | number)[]>('selected', { default: () => [] });
const page = defineModel<number>('page', { default: 1 });
const size = defineModel<number>('size', { default: 20 });

const viewRows = computed(() => {
  if (!props.localSort || !sort.value) return props.rows;
  const { key, dir } = sort.value;
  const mul = dir === 'asc' ? 1 : -1;
  return [...props.rows].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    if (x === y) return 0;
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    return (
      (typeof x === 'number' && typeof y === 'number'
        ? x - y
        : String(x).localeCompare(String(y), 'ko')) * mul
    );
  });
});

const totalCount = computed(() => props.total ?? props.rows.length);
const pageCount = computed(() => Math.max(1, Math.ceil(totalCount.value / size.value)));
const keyOf = (row: T) => row[props.rowKey] as string | number;
const allSelected = computed(
  () => viewRows.value.length > 0 && viewRows.value.every((r) => selected.value.includes(keyOf(r))),
);
const someSelected = computed(
  () => !allSelected.value && viewRows.value.some((r) => selected.value.includes(keyOf(r))),
);

function toggleSort(c: Column): void {
  if (!c.sortable) return;
  sort.value =
    sort.value?.key === c.key
      ? { key: c.key, dir: sort.value.dir === 'asc' ? 'desc' : 'asc' }
      : { key: c.key, dir: 'asc' };
}
function ariaSort(c: Column): 'ascending' | 'descending' | 'none' | undefined {
  if (!c.sortable) return undefined;
  if (sort.value?.key !== c.key) return 'none';
  return sort.value.dir === 'asc' ? 'ascending' : 'descending';
}
function toggleAll(): void {
  selected.value = allSelected.value ? [] : viewRows.value.map(keyOf);
}
function toggleRow(row: T): void {
  const k = keyOf(row);
  selected.value = selected.value.includes(k)
    ? selected.value.filter((x) => x !== k)
    : [...selected.value, k];
}
function go(p: number): void {
  page.value = Math.min(Math.max(1, p), pageCount.value);
}
</script>

<template>
  <div>
    <div class="table-wrap">
      <table class="table">
        <caption v-if="caption" class="sr-only">
          {{
            caption
          }}
        </caption>
        <thead>
          <tr>
            <th v-if="selectable" class="col-check">
              <label class="check">
                <input
                  type="checkbox"
                  :checked="allSelected"
                  :indeterminate="someSelected"
                  aria-label="전체 선택"
                  @change="toggleAll"
                />
                <span class="check-box" aria-hidden="true" />
              </label>
            </th>
            <th
              v-for="c in columns"
              :key="c.key"
              :class="[
                c.class,
                c.sortable ? 'th-sort' : null,
                sort?.key === c.key ? sort.dir : null,
              ]"
              :aria-sort="ariaSort(c)"
              :tabindex="c.sortable ? 0 : undefined"
              scope="col"
              @click="toggleSort(c)"
              @keydown.enter.prevent="toggleSort(c)"
              @keydown.space.prevent="toggleSort(c)"
            >
              {{ c.label }}
            </th>
          </tr>
        </thead>
        <tbody>
          <slot name="prepend" />
          <tr v-if="loading">
            <td :colspan="columns.length + (selectable ? 1 : 0)"><TfSkeleton :lines="3" /></td>
          </tr>
          <template v-else>
            <tr
              v-for="row in viewRows"
              :key="keyOf(row)"
              :class="[rowClass?.(row), { 'is-selected': selected.includes(keyOf(row)) }]"
            >
              <td v-if="selectable" class="col-check">
                <label class="check">
                  <input
                    type="checkbox"
                    :checked="selected.includes(keyOf(row))"
                    :aria-label="`${keyOf(row)} 선택`"
                    @change="toggleRow(row)"
                  />
                  <span class="check-box" aria-hidden="true" />
                </label>
              </td>
              <td v-for="c in columns" :key="c.key" :class="c.class">
                <slot :name="`cell-${c.key}`" :row="row">{{ row[c.key] ?? '' }}</slot>
              </td>
            </tr>
            <tr v-if="viewRows.length === 0">
              <td :colspan="columns.length + (selectable ? 1 : 0)" style="padding: 0">
                <slot name="empty" />
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
    <nav v-if="paginate && totalCount > 0" class="pagination" aria-label="페이지">
      <span class="info">총 {{ totalCount }}건 · {{ page }}/{{ pageCount }} 페이지</span>
      <label class="row text-sm">
        <span>페이지당</span>
        <select
          v-model.number="size"
          class="select select-sm w-80"
          aria-label="페이지당 행 수"
          @change="page = 1"
        >
          <option v-for="s in PAGE_SIZES" :key="s" :value="s">{{ s }}</option>
        </select>
      </label>
      <button
        class="page-btn"
        type="button"
        :disabled="page <= 1"
        aria-label="이전 페이지"
        @click="go(page - 1)"
      >
        ‹
      </button>
      <button class="page-btn is-active" type="button" aria-current="page">{{ page }}</button>
      <button
        class="page-btn"
        type="button"
        :disabled="page >= pageCount"
        aria-label="다음 페이지"
        @click="go(page + 1)"
      >
        ›
      </button>
    </nav>
  </div>
</template>
