import { ref } from 'vue';

/** 라이트박스 상태(화면 그림 id). 앱에 하나(App.vue의 `<Lightbox>`). */
export const lightboxId = ref<string | null>(null);
export const openLightbox = (id: string) => (lightboxId.value = id);
export const closeLightbox = () => (lightboxId.value = null);
