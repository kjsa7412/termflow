<script setup lang="ts">
import TfIcon from './TfIcon.vue';

/**
 * 배지(§10.3 의미 고정 색). kind는 목업 클래스 `badge-{kind}`와 같다:
 * std(초록 '표준') · composed(노랑) · unreg(빨강 '미등록') · code(파랑 '코드') · default(회색 '기본컬럼') ·
 * pending(파랑) · draft(회색) · final(보라) · approved · rejected · accent · outline.
 * 색만으로 의미를 전달하지 않도록 항상 텍스트를 함께 쓴다(§10.6).
 */
defineProps<{
  kind:
    | 'std'
    | 'composed'
    | 'unreg'
    | 'code'
    | 'default'
    | 'pending'
    | 'draft'
    | 'final'
    | 'approved'
    | 'rejected'
    | 'success'
    | 'warning'
    | 'danger'
    | 'info'
    | 'purple'
    | 'gray'
    | 'accent'
    | 'outline';
  icon?: string;
  lg?: boolean;
  mono?: boolean;
}>();

/** 목업에 전용 클래스가 없는 의미 이름 → 목업 색 클래스(코드 = 파랑, 기본컬럼 = 회색, §10.3). */
const CLASS: Record<string, string> = { code: 'info', default: 'gray' };
</script>

<template>
  <span :class="['badge', `badge-${CLASS[kind] ?? kind}`, { 'badge-lg': lg, mono }]">
    <TfIcon v-if="icon" :name="icon" />
    <slot />
  </span>
</template>
