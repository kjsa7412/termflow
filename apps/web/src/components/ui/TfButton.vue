<script setup lang="ts">
import TfIcon from './TfIcon.vue';

/**
 * 버튼(목업 §5): primary / secondary / ghost / danger / danger-ghost / link, sm, 아이콘 전용.
 * `loading`이면 스피너 + 비활성(§10.3 "버튼은 스피너 + 비활성").
 */
const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost' | 'link';
    size?: 'md' | 'sm';
    icon?: string;
    iconOnly?: boolean;
    loading?: boolean;
    disabled?: boolean;
    type?: 'button' | 'submit' | 'reset';
    kbd?: string;
    block?: boolean;
  }>(),
  { variant: 'secondary', size: 'md', type: 'button' },
);
</script>

<template>
  <button
    :type="props.type"
    :class="[
      'btn',
      `btn-${props.variant}`,
      { 'btn-sm': props.size === 'sm', 'btn-icon': props.iconOnly, 'w-full': props.block },
    ]"
    :disabled="props.disabled || props.loading"
    :aria-busy="props.loading || undefined"
  >
    <span v-if="props.loading" class="spinner" aria-hidden="true" />
    <TfIcon v-else-if="props.icon" :name="props.icon" />
    <slot />
    <span v-if="props.kbd" class="kbd">{{ props.kbd }}</span>
  </button>
</template>
