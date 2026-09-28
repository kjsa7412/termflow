<script setup lang="ts">
import TfIcon from './TfIcon.vue';

/** 빈 상태(§10.3·§10.5: 설명 + 1차 동작 버튼). 동작은 기본 슬롯. */
defineProps<{ title: string; desc?: string; icon?: string; inTable?: boolean }>();
</script>

<template>
  <div :class="['empty', { 'in-table': inTable }]">
    <TfIcon :name="icon ?? 'inbox'" />
    <div class="empty-title">{{ title }}</div>
    <div v-if="desc" class="empty-desc">{{ desc }}</div>
    <slot />
  </div>
</template>
