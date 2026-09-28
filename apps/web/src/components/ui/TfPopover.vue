<script setup lang="ts">
import { onBeforeUnmount, ref, useId, watch } from 'vue';

/**
 * 드롭다운·팝오버(목업 §9 `.dropdown`·`.popover`). 트리거는 `trigger` 슬롯(toggle·open 전달),
 * 내용은 기본 슬롯(close 전달). 바깥 클릭·Esc로 닫고 Esc는 트리거로 포커스를 돌려준다.
 */
withDefaults(defineProps<{ align?: 'left' | 'right'; up?: boolean; popover?: boolean }>(), {
  align: 'left',
});
const open = ref(false);
const root = ref<HTMLElement | null>(null);
const menuId = `pop-${useId()}`;

function close(focusTrigger = false): void {
  open.value = false;
  if (focusTrigger) root.value?.querySelector<HTMLElement>('[aria-haspopup]')?.focus();
}
function toggle(): void {
  open.value = !open.value;
}
function onDocClick(e: MouseEvent): void {
  if (root.value && !root.value.contains(e.target as Node)) close();
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') close(true);
}
watch(open, (v) => {
  if (v) {
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
  } else {
    document.removeEventListener('mousedown', onDocClick);
    document.removeEventListener('keydown', onKey);
  }
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick);
  document.removeEventListener('keydown', onKey);
});
defineExpose({ close, open });
</script>

<template>
  <div ref="root" class="dropdown">
    <slot name="trigger" :toggle="toggle" :open="open" :menu-id="menuId" />
    <div
      :id="menuId"
      :class="['dropdown-menu', { 'is-open': open, right: align === 'right', up, popover }]"
      :role="popover ? 'dialog' : 'menu'"
    >
      <slot :close="close" />
    </div>
  </div>
</template>
