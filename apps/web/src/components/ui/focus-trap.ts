import { nextTick, onBeforeUnmount, watch, type Ref } from 'vue';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 모달 포커스 트랩(§10.6): 열리면 `[data-autofocus]`(없으면 첫 위험·주 버튼) 포커스, Tab 순환, Esc로 닫기,
 * 닫히면 열기 전 포커스로 복귀.
 */
export function useFocusTrap(
  open: Ref<boolean>,
  container: Ref<HTMLElement | null>,
  onEscape: () => void,
): void {
  let previous: HTMLElement | null = null;

  function onKeydown(e: KeyboardEvent): void {
    const el = container.value;
    if (!el) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      onEscape();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  watch(
    open,
    async (v) => {
      if (v) {
        previous = document.activeElement as HTMLElement | null;
        document.addEventListener('keydown', onKeydown);
        await nextTick();
        const el = container.value;
        const target =
          el?.querySelector<HTMLElement>('[data-autofocus]') ??
          el?.querySelector<HTMLElement>('.btn-danger, .btn-primary') ??
          el?.querySelector<HTMLElement>(FOCUSABLE);
        target?.focus();
      } else {
        document.removeEventListener('keydown', onKeydown);
        previous?.focus?.();
        previous = null;
      }
    },
    { immediate: true },
  );
  onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown));
}
