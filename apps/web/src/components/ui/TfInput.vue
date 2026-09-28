<script setup lang="ts">
import { computed, useId } from 'vue';
import TfIcon from './TfIcon.vue';

/**
 * 입력(목업 §6 field): 라벨 상단·필수 표시·필드 아래 오류/도움말(§10.3 폼). v-model.
 * 나머지 속성(name·autofocus 등)은 input 요소로 전달한다.
 */
defineOptions({ inheritAttrs: false });
const model = defineModel<string>({ default: '' });
const props = withDefaults(
  defineProps<{
    label?: string;
    type?: string;
    placeholder?: string;
    error?: string | null;
    /** 메시지 없이 오류 테두리만(목업 01_login 아이디 칸). */
    invalid?: boolean;
    help?: string | null;
    valid?: boolean;
    required?: boolean;
    disabled?: boolean;
    readonly?: boolean;
    mono?: boolean;
    size?: 'md' | 'sm';
    autocomplete?: string;
    id?: string;
    ariaLabel?: string;
    maxlength?: number;
  }>(),
  { type: 'text', size: 'md' },
);
const autoId = useId();
const inputId = computed(() => props.id ?? `in-${autoId}`);
const msgId = computed(() => `${inputId.value}-msg`);
</script>

<template>
  <div class="field">
    <label v-if="label" class="field-label" :for="inputId">
      {{ label }}<span v-if="required" class="req" aria-hidden="true">*</span>
    </label>
    <input
      :id="inputId"
      v-model="model"
      :class="[
        'input',
        {
          'is-invalid': !!error || invalid,
          'is-valid': valid && !error,
          mono,
          'input-sm': size === 'sm',
        },
      ]"
      :type="type"
      :placeholder="placeholder"
      :required="required"
      :disabled="disabled"
      :readonly="readonly"
      :autocomplete="autocomplete"
      :aria-label="label ? undefined : ariaLabel"
      :aria-invalid="error || invalid ? 'true' : undefined"
      v-bind="$attrs"
      :aria-describedby="error || help ? msgId : undefined"
      :maxlength="maxlength"
    />
    <span v-if="error" :id="msgId" class="field-error">
      <TfIcon name="alert-circle" size="sm" />{{ error }}
    </span>
    <span v-else-if="help" :id="msgId" :class="['field-help', { 'text-success': valid }]">
      <TfIcon v-if="valid" name="check" size="sm" />{{ help }}
    </span>
  </div>
</template>
