<script setup lang="ts">
import type { SegOption } from './types.js';

/**
 * 필터 칩(목업 `.seg`, §10.3 "필터 칩"): 하나만 선택, 칩마다 건수. `aria-pressed`로 선택 상태를 알린다.
 */
const model = defineModel<string>({ default: '' });
defineProps<{ options: readonly SegOption[]; label: string }>();
const emit = defineEmits<{ change: [value: string] }>();
function pick(v: string): void {
  if (model.value === v) return;
  model.value = v;
  emit('change', v);
}
</script>

<template>
  <div class="seg" role="group" :aria-label="label">
    <button
      v-for="o in options"
      :key="o.value"
      type="button"
      :class="{ 'is-active': model === o.value }"
      :aria-pressed="model === o.value"
      :title="o.title"
      @click="pick(o.value)"
    >
      {{ o.label }}
      <span v-if="o.count !== undefined && o.count !== null" class="count">{{
        o.count.toLocaleString('ko-KR')
      }}</span>
    </button>
  </div>
</template>
