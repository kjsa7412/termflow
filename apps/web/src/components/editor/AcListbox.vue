<script setup lang="ts">
import { computed } from 'vue';
import { acItems, useEditorStore, type EditorRow } from '../../stores/editor.js';
import TfBadge from '../ui/TfBadge.vue';
import TfIcon from '../ui/TfIcon.vue';
import SegmentPieces from './SegmentPieces.vue';

/**
 * 자동완성 후보 listbox(목업 08 `.ac-menu`, 설계서 §10.4 similar·code). 코드구분 후보가 먼저, 이어서 유사 도메인(≤5)과
 * "조합: …" 1건. 키보드(↑↓ Enter Esc)는 논리명 셀이 받고(포커스를 셀에 둔다), 마우스 클릭도 선택된다.
 * `aria-activedescendant`는 논리명 셀이 이 목록의 포커스 항목 id를 가리킨다(§10.6).
 */
const props = defineProps<{ row: EditorRow; listId: string }>();
const emit = defineEmits<{ choose: [index: number] }>();
const ed = useEditorStore();
const items = computed(() => acItems(props.row.ac));
const input = computed(() => props.row.ac?.type ?? null);
const codeCnt = computed(() => items.value.filter((x) => x.kind === 'code').length);
const domainCnt = computed(() => items.value.filter((x) => x.kind === 'domain').length);

/** 입력과 겹치는 부분 강조(목업 `mark`). */
function marked(text: string): { pre: string; hit: string; post: string } {
  const q = props.row.acFor ?? '';
  const i = q ? text.indexOf(q) : -1;
  if (i < 0) return { pre: text, hit: '', post: '' };
  return { pre: text.slice(0, i), hit: q, post: text.slice(i + q.length) };
}
const optionId = (i: number) => `${props.listId}-o${i}`;
defineExpose({ optionId });
</script>

<template>
  <div
    :id="listId"
    class="ac-menu"
    role="listbox"
    :aria-label="codeCnt > 0 ? '코드구분·유사 후보' : '유사 후보'"
    data-testid="ac-listbox"
  >
    <template v-for="(it, i) in items" :key="i">
      <div v-if="i === 0 && it.kind === 'code'" class="ac-section">
        <TfIcon name="code" size="sm" />코드구분 후보 <span class="count-pill">{{ codeCnt }}</span
        ><span class="note">논리명이 '…코드'로 끝남 · 선택하면 코드구분이 연결됩니다</span>
      </div>
      <div
        v-if="it.kind !== 'code' && (i === 0 || items[i - 1]!.kind === 'code')"
        class="ac-section"
      >
        {{ input === 'similar' ? '유사 도메인' : '도메인' }}
        <span v-if="domainCnt > 0" class="count-pill">{{ domainCnt }}</span
        ><span v-if="input === 'similar'" class="note">정확일치 없음 · '{{ row.acFor }}'</span>
      </div>
      <div
        :id="optionId(i)"
        :class="[
          'ac-item',
          {
            'is-focused': row.ac?.focus === i,
            'ac-compose': it.kind === 'composed',
            'ac-code': it.kind === 'code',
          },
        ]"
        role="option"
        :aria-selected="row.ac?.focus === i"
        :data-kind="it.kind"
        @mousedown.prevent
        @mouseenter="ed.acSetFocus(row.uid, i)"
        @click="emit('choose', i)"
      >
        <template v-if="it.kind === 'code'">
          <span class="ac-logical"
            ><TfBadge kind="accent" class="mono">{{ it.code.bizCd }}/{{ it.code.codeCls }}</TfBadge
            >{{ it.code.codeClsNm }}
            <span class="text-muted">· 코드 {{ it.code.codeCnt }}</span></span
          >
          <span class="ac-phys">{{ it.code.physicalNm }}</span>
          <span class="ac-type">{{ it.code.typeText ?? '—' }}</span>
          <span class="ac-hint"
            ><TfBadge kind="accent">코드</TfBadge
            ><span v-if="row.ac?.focus === i" class="kbd">Enter</span></span
          >
          <div v-if="it.code.codes.length > 0" class="ac-codes">
            <TfBadge v-for="c in it.code.codes" :key="c.code" kind="outline" class="mono"
              >{{ c.code }} {{ c.codeNm }}</TfBadge
            >
          </div>
        </template>
        <template v-else-if="it.kind === 'domain'">
          <span class="ac-logical"
            >{{ marked(it.cand.logicalNm).pre }}<mark>{{ marked(it.cand.logicalNm).hit }}</mark
            >{{ marked(it.cand.logicalNm).post }}</span
          >
          <span class="ac-phys">{{ it.cand.physicalNm }}</span>
          <span class="ac-type">{{ it.cand.typeText ?? '—' }}</span>
          <span class="ac-hint"
            ><TfBadge :kind="it.cand.reviewYn ? 'warning' : 'std'">{{
              it.cand.reviewYn ? '검토 필요' : '표준'
            }}</TfBadge
            ><span v-if="row.ac?.focus === i" class="kbd">Enter</span></span
          >
        </template>
        <template v-else>
          <span class="ac-logical"
            ><span class="text-muted">조합:</span><SegmentPieces :segments="it.cand.segments ?? []"
          /></span>
          <span class="ac-phys">{{ it.cand.physicalNm }}</span>
          <span class="ac-type">{{ it.cand.typeText ?? '—' }}</span>
          <span class="ac-hint"
            ><TfBadge kind="composed">조합</TfBadge
            ><span v-if="row.ac?.focus === i" class="kbd">Enter</span></span
          >
        </template>
      </div>
    </template>
    <div class="ac-footer">
      <span><span class="kbd">↑</span><span class="kbd">↓</span> 이동</span>
      <span><span class="kbd">Enter</span> 선택</span>
      <span><span class="kbd">Esc</span> 닫고 직접 입력</span>
    </div>
  </div>
</template>
