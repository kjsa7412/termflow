<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { SCREENS, shotUrl } from '../data/screens.js';
import { closeLightbox, lightboxId } from './lightbox.js';

/** 화면 그림 크게 보기 — Esc·바깥 누르기로 닫고, ← → 로 앞뒤 그림. 열면 닫기 단추로 포커스, 닫으면 원래 자리로. */
const index = computed(() => SCREENS.findIndex((s) => s.id === lightboxId.value));
const screen = computed(() => SCREENS[index.value] ?? null);
const closeBtn = ref<HTMLButtonElement | null>(null);
let opener: HTMLElement | null = null;

function step(d: number): void {
  if (index.value < 0) return;
  lightboxId.value = SCREENS[(index.value + d + SCREENS.length) % SCREENS.length]!.id;
}
function onKey(e: KeyboardEvent): void {
  if (!lightboxId.value) return;
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowRight') step(1);
  else if (e.key === 'ArrowLeft') step(-1);
}
watch(lightboxId, async (id, prev) => {
  document.documentElement.classList.toggle('no-scroll', Boolean(id));
  if (id && !prev) {
    opener = document.activeElement as HTMLElement | null;
    await nextTick();
    closeBtn.value?.focus();
  } else if (!id) opener?.focus();
});
onMounted(() => addEventListener('keydown', onKey));
onBeforeUnmount(() => removeEventListener('keydown', onKey));
</script>

<template>
  <div
    v-if="screen"
    class="lb"
    role="dialog"
    aria-modal="true"
    :aria-label="`${screen.title} 화면`"
    @click.self="closeLightbox"
  >
    <div class="lb__top">
      <span class="lb__count">{{ index + 1 }} / {{ SCREENS.length }}</span>
      <b>{{ screen.title }}</b>
      <span class="sp" />
      <button type="button" class="lb__btn" aria-label="이전 그림" @click="step(-1)">‹</button>
      <button type="button" class="lb__btn" aria-label="다음 그림" @click="step(1)">›</button>
      <button ref="closeBtn" type="button" class="lb__btn" aria-label="닫기" @click="closeLightbox">
        ✕
      </button>
    </div>
    <img class="lb__img" :src="shotUrl(screen.id)" :alt="`${screen.title} — ${screen.desc}`" />
    <p class="lb__desc">{{ screen.desc }}</p>
  </div>
</template>
