<script setup lang="ts">
/** 아이콘(CSS 마스크 `.ico-{name}`, currentColor). 장식이므로 aria-hidden. */
defineProps<{ name: string; size?: 'sm' | 'lg' | 'xl' }>();
</script>

<template>
  <span :class="['ico', `ico-${name}`, size ? `ico-${size}` : null]" aria-hidden="true" />
</template>
