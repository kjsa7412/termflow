<script setup lang="ts">
import { useToastStore } from '../../stores/toast.js';

/** 토스트 영역(§10.3 우하단, §10.6 `aria-live=polite`). 오류 토스트는 [닫기] 또는 8초 뒤 닫힌다(CR-15 C6). */
const toasts = useToastStore();
</script>

<template>
  <div class="toast-region" aria-live="polite" role="status">
    <div v-for="t in toasts.items" :key="t.id" :class="['toast', `toast-${t.type}`]">
      <span>{{ t.text }}</span>
      <button
        v-if="t.type === 'error'"
        class="toast-action"
        type="button"
        @click="toasts.dismiss(t.id)"
      >
        닫기
      </button>
    </div>
  </div>
</template>
