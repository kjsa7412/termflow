<script setup lang="ts">
import { ref, toRef, useId, watch } from 'vue';
import TfButton from './TfButton.vue';
import TfIcon from './TfIcon.vue';
import { useFocusTrap } from './focus-trap.js';

/**
 * 모달 2/2 — 충돌 병합(§8.1, 목업 14_conflict, G9). 409 version-conflict 때 편집기(단계 8)가 연다.
 * 본문(두 버전 비교)은 기본 슬롯. 덮어쓰기는 "되돌린다는 것을 확인" 체크 후에만 활성(목업과 동일).
 * 동작: [최신본 새로고침(임시저장본 유지)] / [내 편집본으로 덮어쓰기]. Esc·바깥 클릭은 닫지 않는다(결정 강제).
 */
const props = defineProps<{
  open: boolean;
  savedBy: string;
  savedAt: string;
  yourVersion: number;
  currentVersion: number;
  changeCount?: number;
  busy?: boolean;
}>();
const emit = defineEmits<{ reload: []; overwrite: [] }>();
const box = ref<HTMLElement | null>(null);
const titleId = `mdl-${useId()}`;
const acknowledged = ref(false);
watch(
  () => props.open,
  () => (acknowledged.value = false),
);
useFocusTrap(toRef(props, 'open'), box, () => undefined);
</script>

<template>
  <div
    v-if="open"
    class="modal-backdrop is-open"
    role="dialog"
    aria-modal="true"
    :aria-labelledby="titleId"
  >
    <div ref="box" class="modal modal-lg">
      <div :id="titleId" class="modal-title">
        <TfIcon name="git-merge" class="text-warning" />저장 충돌 — 다른 사용자가 먼저 저장했습니다
        <span class="badge badge-outline mono">409</span>
      </div>
      <div class="modal-body">
        <div class="alert alert-warning mb-4">
          <TfIcon name="alert-triangle" />
          <div class="alert-body">
            <div class="alert-title">
              <strong>{{ savedBy }}</strong> 님이 <strong>{{ savedAt }}</strong
              >에 이 테이블을 저장했습니다 (v{{ currentVersion }}).
            </div>
            내 편집본은 v{{ yourVersion }}을 기준으로 합니다. 아무것도 잃지 않았습니다 — 내 편집본은
            브라우저에 임시저장되어 있습니다. 아래에서 두 버전을 비교한 뒤 선택하세요.
          </div>
        </div>
        <slot />
      </div>
      <div class="modal-footer">
        <label class="check left">
          <input v-model="acknowledged" type="checkbox" />
          <span class="check-box" aria-hidden="true" />{{ savedBy }} 님의 변경{{
            changeCount !== undefined ? ` ${changeCount}건` : ''
          }}을 되돌린다는 것을 확인했습니다
        </label>
        <TfButton variant="secondary" icon="refresh" data-autofocus @click="emit('reload')">
          최신본 새로고침 (임시저장본 유지)
        </TfButton>
        <TfButton
          variant="danger"
          icon="save"
          :disabled="!acknowledged"
          :loading="busy"
          @click="emit('overwrite')"
        >
          내 편집본으로 덮어쓰기
        </TfButton>
      </div>
    </div>
  </div>
</template>
