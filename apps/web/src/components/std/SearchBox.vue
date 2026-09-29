<script setup lang="ts">
import TfIcon from '../ui/TfIcon.vue';

/** 목록 검색창(목업 04 toolbar `.input-wrap`). 디바운스는 useServerList가 한다. Esc = 지우기. */
const model = defineModel<string>({ default: '' });
withDefaults(defineProps<{ placeholder?: string; label: string; width?: string }>(), {
  width: 'w-320',
});
</script>

<template>
  <div :class="['input-wrap', width]">
    <TfIcon name="search" />
    <input
      v-model="model"
      class="input"
      type="search"
      :placeholder="placeholder"
      :aria-label="label"
      @keydown.esc="model = ''"
    />
  </div>
</template>
