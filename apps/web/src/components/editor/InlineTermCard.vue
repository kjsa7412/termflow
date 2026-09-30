<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import { useEditorStore, type EditorRow } from '../../stores/editor.js';
import TfBadge from '../ui/TfBadge.vue';
import TfIcon from '../ui/TfIcon.vue';

/**
 * 미등록 용어 인라인 등록 카드(목업 08 `.reg-card`, 설계서 §10.4 unregistered·§5.9, S4·G2). 모달이 아니다(G9) — 행 아래 카드.
 * 한글 용어는 분절 결과에서 고정(후보가 둘 이상이면 고르기, CR-08 C7), 물리약어 입력 → Enter [등록 후 적용]
 * → 검토대기(PENDING) 등록 → 같은 논리명 자동 재시도. Esc = 카드 닫고 수동 입력(미등록 경고 유지).
 */
const props = defineProps<{ row: EditorRow }>();
const emit = defineEmits<{ submit: []; cancel: [] }>();
const ed = useEditorStore();
const phys = ref<HTMLInputElement | null>(null);
const id = (f: string) => `reg-${f}-${props.row.uid}`;

async function focus(): Promise<void> {
  await nextTick();
  phys.value?.focus();
}
onMounted(() => void focus());
defineExpose({ focus });

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    emit('submit');
  } else if (e.key === 'Escape') {
    e.preventDefault();
    emit('cancel');
  }
}
function onPhysInput(e: Event): void {
  // 물리약어는 영대문자·숫자·_ — 입력 중 대문자로 맞춘다(서버 형식 검사 전 흔한 실수 방지)
  const t = e.target as HTMLInputElement;
  ed.setReg(props.row.uid, 'physical', t.value.toUpperCase());
}
</script>

<template>
  <div
    v-if="row.ac"
    class="reg-card"
    role="group"
    aria-label="미등록 용어 인라인 등록"
    data-testid="reg-card"
    @keydown="onKey"
  >
    <div class="reg-title">
      <TfIcon name="plus" />미등록 용어를 그 자리에서 등록
      <TfBadge kind="pending">검토대기(PENDING)로 저장</TfBadge>
    </div>
    <div class="field">
      <label class="field-label" :for="id('kor')">한글 용어</label>
      <input :id="id('kor')" class="input" :value="row.ac.reg.kor" readonly />
      <span v-if="row.ac.registerCandidates.length > 1" class="reg-choices">
        <button
          v-for="k in row.ac.registerCandidates"
          :key="k"
          type="button"
          :class="['btn', 'btn-ghost', 'btn-sm', { 'is-active': row.ac.reg.kor === k }]"
          :aria-pressed="row.ac.reg.kor === k"
          @click="(ed.setReg(row.uid, 'kor', k), focus())"
        >
          {{ k }}
        </button>
      </span>
    </div>
    <div class="field">
      <label class="field-label" :for="id('phys')">물리약어 <span class="req">*</span></label>
      <input
        :id="id('phys')"
        ref="phys"
        class="input mono"
        :value="row.ac.reg.physical"
        maxlength="30"
        autocomplete="off"
        spellcheck="false"
        :aria-invalid="row.ac.reg.error ? 'true' : undefined"
        data-testid="reg-physical"
        @input="onPhysInput"
      />
      <span v-if="row.ac.reg.error" class="field-help text-danger" role="alert">{{
        row.ac.reg.error
      }}</span>
    </div>
    <div class="field field-grow">
      <label class="field-label" :for="id('desc')">설명 (선택)</label>
      <input
        :id="id('desc')"
        class="input"
        :value="row.ac.reg.description"
        maxlength="500"
        @input="ed.setReg(row.uid, 'description', ($event.target as HTMLInputElement).value)"
      />
    </div>
    <button
      class="btn btn-primary"
      type="button"
      :disabled="row.ac.reg.busy || row.ac.reg.physical.trim() === ''"
      data-testid="reg-submit"
      @click="emit('submit')"
    >
      <span v-if="row.ac.reg.busy" class="spinner" />등록 후 적용 <span class="kbd">Enter</span>
    </button>
    <button class="btn btn-ghost" type="button" @click="emit('cancel')">
      건너뛰기 <span class="kbd">Esc</span>
    </button>
    <div class="reg-note">
      <TfIcon name="info" size="sm" />등록 즉시 자동완성을 다시 실행해 물리명·타입을 채우고 다음
      행으로 이동합니다. 관리자가 승인 큐에서 승인·정정·반려하며, 반려되면 이 컬럼에 경고가
      표시됩니다.
    </div>
  </div>
</template>
