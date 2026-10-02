<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';

/**
 * 드롭다운·팝오버(목업 §9 `.dropdown`·`.popover`). 트리거는 `trigger` 슬롯(toggle·open 전달),
 * 내용은 기본 슬롯(close 전달). 바깥 클릭·Esc로 닫고 Esc는 트리거로 포커스를 돌려준다.
 * CR-15 C8: 메뉴는 트리거 위치를 재서 화면 기준(position: fixed)으로 띄운다 — 가로 스크롤 표(`.table-wrap`·`.grid-wrap`)
 * 안의 행 메뉴가 표 상자에 잘리지 않게. 아래 공간이 모자라면 위로, 화면 밖으로 나가지 않게 좌우를 맞춘다.
 * 바깥 스크롤·창 크기 변경 때는 닫는다(트리거와 어긋나지 않게).
 */
const props = withDefaults(
  defineProps<{ align?: 'left' | 'right'; up?: boolean; popover?: boolean }>(),
  { align: 'left' },
);
const open = ref(false);
const root = ref<HTMLElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const placed = ref<Record<string, string>>({});
const menuId = `pop-${useId()}`;
const GAP = 4;
const EDGE = 8;

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
function onScroll(e: Event): void {
  if (menu.value && e.target instanceof Node && menu.value.contains(e.target)) return;
  close();
}
function onResize(): void {
  close();
}

/** 트리거 바로 아래(공간이 모자라면 위)에 맞춘다. 트리거가 메뉴 최소 폭보다 넓으면 그 폭에 맞춘다(프로젝트 전환). */
async function place(first = true): Promise<void> {
  if (first) placed.value = { position: 'fixed', visibility: 'hidden' };
  await nextTick();
  const m = menu.value;
  const trigger = root.value?.querySelector<HTMLElement>('[aria-haspopup]') ?? root.value;
  if (!m || !trigger || !open.value) return;
  const t = trigger.getBoundingClientRect();
  const minWidth = Number.parseFloat(getComputedStyle(m).minWidth) || 0;
  const width = Math.max(m.offsetWidth, t.width > minWidth ? t.width : 0);
  const height = m.offsetHeight;
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = document.documentElement.clientHeight || window.innerHeight;
  const below = t.bottom + GAP;
  const above = t.top - GAP - height;
  const fitsBelow = below + height <= vh - EDGE;
  const fitsAbove = above >= EDGE;
  const top = props.up
    ? fitsAbove || !fitsBelow
      ? above
      : below
    : fitsBelow || !fitsAbove
      ? below
      : above;
  let left = props.align === 'right' ? t.right - width : t.left;
  left = Math.min(left, vw - width - EDGE);
  left = Math.max(left, EDGE);
  placed.value = {
    position: 'fixed',
    top: `${Math.max(EDGE, Math.round(top))}px`,
    left: `${Math.round(left)}px`,
    right: 'auto',
    bottom: 'auto',
    ...(t.width > minWidth ? { minWidth: `${Math.round(t.width)}px` } : {}),
  };
}

// 내용이 나중에 바뀌면(코드구분 검색 결과 등) 높이가 달라지므로 다시 맞춘다
let sizeWatch: ResizeObserver | null = null;
watch(open, (v) => {
  if (v) {
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    void place().then(() => {
      if (typeof ResizeObserver === 'undefined' || !menu.value || !open.value) return;
      sizeWatch = new ResizeObserver(() => void place(false));
      sizeWatch.observe(menu.value);
    });
  } else {
    removeListeners();
    placed.value = {};
  }
});
function removeListeners(): void {
  document.removeEventListener('mousedown', onDocClick);
  document.removeEventListener('keydown', onKey);
  window.removeEventListener('scroll', onScroll, true);
  window.removeEventListener('resize', onResize);
  sizeWatch?.disconnect();
  sizeWatch = null;
}
onBeforeUnmount(removeListeners);
defineExpose({ close, open });
</script>

<template>
  <div ref="root" class="dropdown">
    <slot name="trigger" :toggle="toggle" :open="open" :menu-id="menuId" />
    <div
      :id="menuId"
      ref="menu"
      :class="['dropdown-menu', { 'is-open': open, right: align === 'right', up, popover }]"
      :style="open ? placed : undefined"
      :role="popover ? 'dialog' : 'menu'"
    >
      <slot :close="close" />
    </div>
  </div>
</template>
