<script setup lang="ts">
import type { AutocompleteSegment } from '@termflow/shared';

/**
 * 분절 조각 배지(목업 08 `.pieces`, 설계서 §10.4 composed·unregistered). 매칭 = 초록(한글 + 물리약어), 미매칭 = 빨간 점선
 * + "미등록", 검토대기(PENDING) 용어 = 조각 뒤 '검토대기' 표시(§4.5). 색 + 텍스트 병기(§10.6).
 */
defineProps<{ segments: readonly AutocompleteSegment[]; result?: string | null }>();
</script>

<template>
  <span class="pieces" data-testid="pieces">
    <template v-for="(s, i) in segments" :key="i">
      <span v-if="i > 0" class="piece-sep" aria-hidden="true">│</span>
      <span
        v-if="s.matched"
        :class="['piece', 'piece-ok', { 'piece-pending': s.status === 'PENDING' }]"
        :title="
          s.status === 'PENDING' ? '검토대기(PENDING) 용어 — 승인 전에도 쓸 수 있습니다' : undefined
        "
        >{{ s.kor }} <code>{{ s.physical }}</code
        ><span v-if="s.status === 'PENDING'" class="piece-flag">검토대기</span></span
      >
      <span v-else class="piece piece-miss">{{ s.kor }} · 미등록</span>
    </template>
    <template v-if="result">
      <span class="arrow" aria-hidden="true">→</span>
      <span class="piece"
        ><code>{{ result }}</code></span
      >
    </template>
  </span>
</template>
