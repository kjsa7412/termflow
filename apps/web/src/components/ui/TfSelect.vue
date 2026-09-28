<script setup lang="ts">
import { computed, useId } from 'vue';

/** 셀렉트(목업 §6 `.select`). options: {value, label}[]. v-model. */
const model = defineModel<string>({ default: '' });
const props = defineProps<{
  options: readonly { value: string; label: string }[];
  label?: string;
  ariaLabel?: string;
  size?: 'md' | 'sm';
  disabled?: boolean;
  id?: string;
}>();
const autoId = useId();
const selectId = computed(() => props.id ?? `sel-${autoId}`);
</script>

<template>
  <div class="field">
    <label v-if="label" class="field-label" :for="selectId">{{ label }}</label>
    <select
      :id="selectId"
      v-model="model"
      :class="['select', { 'select-sm': size === 'sm' }]"
      :aria-label="label ? undefined : ariaLabel"
      :disabled="disabled"
    >
      <option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option>
    </select>
  </div>
</template>
