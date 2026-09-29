<script setup lang="ts">
import { ref, toRef, useId } from 'vue';
import TfButton from './TfButton.vue';
import TfIcon from './TfIcon.vue';
import { useFocusTrap } from './focus-trap.js';

/**
 * 모달 1/2 — 삭제 확인(§10.3 "모달 2종", G9). 대상 이름을 제목에 표시하고 위험 버튼으로 확정한다.
 * 보조 동작(예: 비활성화)은 `secondaryLabel`. 포커스 트랩·Esc 닫기(§10.6).
 */
const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    confirmLabel?: string;
    secondaryLabel?: string;
    busy?: boolean;
    /** 확인 조건(예: 키 재입력)이 맞을 때까지 위험 버튼 비활성. */
    confirmDisabled?: boolean;
  }>(),
  { confirmLabel: '삭제' },
);
const emit = defineEmits<{ confirm: []; secondary: []; cancel: [] }>();
const box = ref<HTMLElement | null>(null);
const titleId = `mdl-${useId()}`;
useFocusTrap(toRef(props, 'open'), box, () => emit('cancel'));
</script>

<template>
  <div
    v-if="open"
    class="modal-backdrop is-open"
    role="dialog"
    aria-modal="true"
    :aria-labelledby="titleId"
    @click.self="emit('cancel')"
  >
    <div ref="box" class="modal">
      <div :id="titleId" class="modal-title">
        <TfIcon name="trash" class="text-danger" />{{ title }}
      </div>
      <div class="modal-body"><slot /></div>
      <div class="modal-footer">
        <TfButton variant="secondary" @click="emit('cancel')">취소</TfButton>
        <TfButton v-if="secondaryLabel" variant="secondary" @click="emit('secondary')">
          {{ secondaryLabel }}
        </TfButton>
        <TfButton
          variant="danger"
          :loading="busy"
          :disabled="confirmDisabled"
          @click="emit('confirm')"
        >
          {{ confirmLabel }}
        </TfButton>
      </div>
    </div>
  </div>
</template>
