import { defineStore } from 'pinia';
import { ref } from 'vue';

export type ToastType = 'success' | 'error' | 'info';
export interface Toast {
  id: number;
  text: string;
  type: ToastType;
}

/** 토스트(§10.3): 우하단, 성공·정보 3초 자동 닫힘, 오류는 수동 닫기. 표시는 ToastRegion(aria-live=polite). */
export const useToastStore = defineStore('toast', () => {
  const items = ref<Toast[]>([]);
  let seq = 0;

  function push(text: string, type: ToastType = 'success', ms = 3000): number {
    const id = ++seq;
    items.value.push({ id, text, type });
    if (type !== 'error') setTimeout(() => dismiss(id), ms);
    return id;
  }

  function dismiss(id: number): void {
    items.value = items.value.filter((t) => t.id !== id);
  }

  return {
    items,
    push,
    dismiss,
    success: (t: string) => push(t, 'success'),
    error: (t: string) => push(t, 'error'),
    info: (t: string) => push(t, 'info'),
  };
});
