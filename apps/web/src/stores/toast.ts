import { defineStore } from 'pinia';
import { ref } from 'vue';
import { fillJosa } from '@termflow/shared';

export type ToastType = 'success' | 'error' | 'info';
export interface Toast {
  id: number;
  text: string;
  type: ToastType;
}

/** 동시에 보이는 최대 개수(넘치면 오래된 것부터 닫음). */
export const TOAST_MAX = 3;
/** 자동 닫힘: 성공·정보 3초, 오류 8초([닫기]로 먼저 닫을 수 있음). */
export const TOAST_MS = { success: 3000, info: 3000, error: 8000 } as const;

/**
 * 토스트(§10.3): 우하단, 표시는 ToastRegion(aria-live=polite).
 * CR-15 C6: 오류도 8초 뒤 닫힌다(전에는 수동 닫기만 — 쌓여서 DDL 패널 [복사]·[다운로드]를 가렸다). 같은 문구가 떠 있으면
 * 새로 쌓지 않고 시간만 다시 잰다. 최대 3개.
 */
export const useToastStore = defineStore('toast', () => {
  const items = ref<Toast[]>([]);
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let seq = 0;

  function arm(id: number, ms: number): void {
    clearTimeout(timers.get(id));
    timers.set(
      id,
      setTimeout(() => dismiss(id), ms),
    );
  }

  function push(raw: string, type: ToastType = 'success', ms: number = TOAST_MS[type]): number {
    const text = fillJosa(raw); // "QATEST을(를)" → "QATEST를"(CR-15 C13)
    const same = items.value.find((t) => t.text === text && t.type === type);
    if (same) {
      arm(same.id, ms);
      return same.id;
    }
    const id = ++seq;
    items.value.push({ id, text, type });
    arm(id, ms);
    while (items.value.length > TOAST_MAX) dismiss(items.value[0]!.id);
    return id;
  }

  function dismiss(id: number | null | undefined): void {
    if (id === null || id === undefined) return;
    clearTimeout(timers.get(id));
    timers.delete(id);
    items.value = items.value.filter((t) => t.id !== id);
  }

  return {
    items,
    push,
    dismiss,
    success: (t: string) => push(t, 'success'),
    error: (t: string) => push(t, 'error'),
    info: (t: string, ms?: number) => push(t, 'info', ms),
  };
});
