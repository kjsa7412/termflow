<script setup lang="ts">
import { computed, ref } from 'vue';
import { alignColumns, describe, diffCount, type CompareColumn } from '../../editor/compare.js';
import TfBadge from '../ui/TfBadge.vue';
import TfIcon from '../ui/TfIcon.vue';

/**
 * 두 버전 나란히 비교(목업 14 `.compare`, §8.1·§8.3·§8.7). 컬럼 ID → 물리명 순으로 짝을 맞추고, 동일 행은 접는다.
 * 충돌 병합 모달(최신본 ↔ 내 편집본)·이력 패널(과거 버전 ↔ 현재)·임시저장 비교가 같이 쓴다.
 */
const props = defineProps<{
  left: readonly CompareColumn[];
  right: readonly CompareColumn[];
  leftTitle: string;
  rightTitle: string;
  leftMeta?: string;
  rightMeta?: string;
}>();
const rows = computed(() => alignColumns(props.left, props.right));
const diff = computed(() => diffCount(rows.value));
const same = computed(() => rows.value.length - diff.value);
const showSame = ref(false);
const visible = computed(() => rows.value.filter((r) => showSame.value || r.kind !== 'same'));
const cls = (kind: string, side: 'l' | 'r') =>
  kind === 'chg'
    ? 'diff-chg'
    : kind === 'left'
      ? side === 'l'
        ? 'diff-add'
        : 'diff-empty'
      : kind === 'right'
        ? side === 'r'
          ? 'diff-add'
          : 'diff-empty'
        : '';
defineExpose({ diff });
</script>

<template>
  <div data-testid="column-compare">
    <div class="row mb-3">
      <div class="diff-legend">
        <span><i class="legend-add" />이쪽에만 있음</span><span><i class="legend-chg" />변경</span
        ><span><i class="legend-empty" />상대 버전에 없음</span>
      </div>
      <span class="spacer" />
      <span class="text-sm text-muted" data-testid="compare-summary"
        >차이 {{ diff }}건 · 동일 컬럼 {{ same }}건{{ showSame ? '' : '은 접힘' }}</span
      >
      <button v-if="same > 0" class="btn btn-ghost btn-sm" type="button" @click="showSame = !showSame">
        동일 컬럼 {{ showSame ? '접기' : '펼치기' }}
      </button>
    </div>
    <div class="compare">
      <div class="compare-col">
        <div class="compare-head">
          <TfIcon name="database" />{{ leftTitle }}<span v-if="leftMeta" class="meta">{{ leftMeta }}</span>
        </div>
        <div
          v-for="(r, i) in visible"
          :key="`l${i}`"
          :class="['diff-row', cls(r.kind, 'l')]"
          :data-kind="r.kind"
        >
          <span class="n">{{ r.leftNo ?? '—' }}</span>
          <span>{{ r.left?.logicalNm ?? '(없음)' }}</span>
          <span class="mono">{{ r.left ? describe(r.left) : '—' }}</span>
          <span>
            <TfBadge v-if="r.left?.isPk" kind="std">PK</TfBadge>
            <TfBadge v-if="r.kind === 'chg'" kind="warning">{{ r.changes.join('·') }} 변경</TfBadge>
            <TfBadge v-else-if="r.kind === 'left'" kind="success">이쪽에만</TfBadge>
          </span>
          <span />
        </div>
      </div>
      <div class="compare-col">
        <div class="compare-head">
          <TfIcon name="edit" />{{ rightTitle }}<span v-if="rightMeta" class="meta">{{ rightMeta }}</span>
        </div>
        <div
          v-for="(r, i) in visible"
          :key="`r${i}`"
          :class="['diff-row', cls(r.kind, 'r')]"
          :data-kind="r.kind"
        >
          <span class="n">{{ r.rightNo ?? '—' }}</span>
          <span>{{ r.right?.logicalNm ?? '(없음)' }}</span>
          <span class="mono">{{ r.right ? describe(r.right) : '—' }}</span>
          <span>
            <TfBadge v-if="r.right?.isPk" kind="std">PK</TfBadge>
            <TfBadge v-if="r.kind === 'chg'" kind="warning">{{ r.changes.join('·') }} 변경</TfBadge>
            <TfBadge v-else-if="r.kind === 'right'" kind="success">이쪽에만</TfBadge>
          </span>
          <span />
        </div>
      </div>
    </div>
  </div>
</template>
