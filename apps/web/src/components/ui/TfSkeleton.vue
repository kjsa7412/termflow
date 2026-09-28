<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

/** 스켈레톤(§10.5: 200ms 이내면 표시 없음, 이후 스켈레톤). */
const props = withDefaults(defineProps<{ lines?: number; delay?: number }>(), {
  lines: 3,
  delay: 200,
});
const visible = ref(props.delay === 0);
let timer: ReturnType<typeof setTimeout> | undefined;
onMounted(() => {
  if (!visible.value) timer = setTimeout(() => (visible.value = true), props.delay);
});
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <div v-if="visible" role="status" aria-label="불러오는 중">
    <span
      v-for="i in lines"
      :key="i"
      class="skeleton"
      :style="{ width: i === lines ? '60%' : '100%' }"
    />
  </div>
</template>
