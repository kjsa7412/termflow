<script setup lang="ts">
import { computed } from 'vue';
import { PAGE_SIZES } from '../ui/data-table.js';

/** 목록 페이지네이션(§10.3 20/50/100, 목업 `.pagination`). 서버 페이지(useServerList)와 v-model로 연결한다. */
const page = defineModel<number>('page', { default: 1 });
const size = defineModel<number>('size', { default: 20 });
const props = defineProps<{ total: number }>();
const pageCount = computed(() => Math.max(1, Math.ceil(props.total / size.value)));
const from = computed(() => (props.total === 0 ? 0 : (page.value - 1) * size.value + 1));
const to = computed(() => Math.min(props.total, page.value * size.value));
/** 앞뒤 2쪽 + 처음·끝(목업 "1 2 3 … 143"). */
const pages = computed(() => {
  const n = pageCount.value;
  const set = new Set(
    [1, n, page.value - 1, page.value, page.value + 1].filter((p) => p >= 1 && p <= n),
  );
  return [...set].sort((a, b) => a - b);
});
function go(p: number): void {
  page.value = Math.min(Math.max(1, p), pageCount.value);
}
</script>

<template>
  <nav v-if="total > 0" class="pagination" aria-label="페이지">
    <span class="info"
      >{{ from.toLocaleString('ko-KR') }}–{{ to.toLocaleString('ko-KR') }} /
      {{ total.toLocaleString('ko-KR') }} · 페이지당
      <select v-model.number="size" class="select select-sm w-80" aria-label="페이지당 행 수">
        <option v-for="s in PAGE_SIZES" :key="s" :value="s">{{ s }}</option>
      </select></span
    >
    <button
      class="page-btn"
      type="button"
      :disabled="page <= 1"
      aria-label="이전 페이지"
      @click="go(page - 1)"
    >
      ‹
    </button>
    <template v-for="(p, i) in pages" :key="p">
      <span v-if="i > 0 && p - pages[i - 1]! > 1" class="text-muted">…</span>
      <button
        :class="['page-btn', { 'is-active': p === page }]"
        type="button"
        :aria-current="p === page ? 'page' : undefined"
        @click="go(p)"
      >
        {{ p }}
      </button>
    </template>
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
</template>
