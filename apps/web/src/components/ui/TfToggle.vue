<script setup lang="ts">
/** 토글 스위치(목업 §6 `.switch`, role=switch). */
const model = defineModel<boolean>({ default: false });
defineProps<{ disabled?: boolean; ariaLabel?: string; title?: string }>();
</script>

<template>
  <label class="switch" :title="title">
    <input
      v-model="model"
      type="checkbox"
      role="switch"
      :aria-checked="model"
      :disabled="disabled"
      :aria-label="ariaLabel"
    />
    <span class="switch-track" aria-hidden="true" />
    <slot />
  </label>
</template>
