<script setup lang="ts">
import { computed } from 'vue';
import { SCREENS, shotUrl } from '../data/screens.js';
import { openLightbox } from './lightbox.js';

/** 화면 그림 한 장 — 창 테두리 + 설명. 누르면 크게(라이트박스). */
const props = defineProps<{ id: string; caption?: boolean; eager?: boolean }>();
const screen = computed(() => SCREENS.find((s) => s.id === props.id)!);
const src = computed(() => shotUrl(props.id));
</script>

<template>
  <figure class="shot">
    <button
      type="button"
      class="shot__frame"
      :aria-label="`${screen.title} 화면 크게 보기`"
      @click="openLightbox(id)"
    >
      <span class="shot__bar" aria-hidden="true"><i /><i /><i /></span>
      <img
        :src="src"
        :alt="`${screen.title} — ${screen.desc}`"
        width="1440"
        height="900"
        :loading="eager ? 'eager' : 'lazy'"
        decoding="async"
      />
    </button>
    <figcaption v-if="caption !== false">
      <b>{{ screen.title }}</b> — {{ screen.desc }}
    </figcaption>
  </figure>
</template>
