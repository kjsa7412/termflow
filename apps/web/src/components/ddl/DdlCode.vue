<script setup lang="ts">
import { computed } from 'vue';
import { tokenize } from './highlight.js';

/**
 * DDL 구문 강조 보기(목업 10 `pre.code`, T7.12): 읽기 전용. `warnColumns`의 컬럼 정의 줄은 경고 배경(`.l.warn`).
 * 긴 출력(33 테이블 약 1,500줄)도 토큰 단위 텍스트 노드라 v-html 없이 안전하게 그린다.
 */
const props = withDefaults(
  defineProps<{ sql: string; warnColumns?: readonly string[]; label?: string }>(),
  { warnColumns: () => [], label: 'DDL 미리보기' },
);
const lines = computed(() => tokenize(props.sql));
const warn = computed(() => new Set(props.warnColumns.map((c) => c.toUpperCase())));
function isWarn(first: string | undefined): boolean {
  if (!first || warn.value.size === 0) return false;
  return warn.value.has(first.replace(/"/g, '').toUpperCase());
}
/** 컬럼 정의 줄의 첫 식별자(들여쓰기 뒤). */
const firstId = (tokens: { k: string; v: string }[]) =>
  tokens.length > 1 && tokens[0]!.k === '' && tokens[0]!.v.trim() === '' && tokens[1]!.k === 'id'
    ? tokens[1]!.v
    : undefined;
</script>

<template>
  <pre class="code" role="region" :aria-label="label" tabindex="0" data-testid="ddl-code"><template
      v-for="(tokens, i) in lines"
      :key="i"
    ><span :class="['l', { warn: isWarn(firstId(tokens)) }]"><template
          v-for="(t, j) in tokens"
          :key="j"
        ><span v-if="t.k" :class="t.k">{{ t.v }}</span><template v-else>{{ t.v }}</template></template></span>{{ '\n' }}</template></pre>
</template>
