<script setup lang="ts">
/** 체크박스(목업 §6 `.check`): 실제 input은 시각적으로 숨기고 키보드·스크린리더는 그대로. */
const model = defineModel<boolean>({ default: false });
defineProps<{ disabled?: boolean; ariaLabel?: string }>();
</script>

<template>
  <label :class="['check', { 'is-disabled': disabled }]">
    <input v-model="model" type="checkbox" :disabled="disabled" :aria-label="ariaLabel" />
    <span class="check-box" aria-hidden="true" />
    <slot />
  </label>
</template>
