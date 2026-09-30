<script setup lang="ts">
import { computed, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { useEditorStore } from '../../stores/editor.js';
import TfBadge from '../ui/TfBadge.vue';
import TfIcon from '../ui/TfIcon.vue';

/**
 * 기본컬럼 영역(설계서 §8.2·§10.4, 목업 08 `.default-cols`, T8.10): 그리드 아래 고정, 접기, 개별 제외.
 * 새 테이블은 프로젝트 기본 세트를 선삽입(포함), 기존 테이블은 `default_col_id`가 있는 컬럼 + 세트에 있지만 빠진 컬럼(제외 상태).
 * 편집은 포함/제외만 — 제외 = 저장 본문에서 빠짐 = 행 삭제(§8.2). 저장 본문에서 일반 컬럼 뒤에 온다.
 */
defineProps<{ readOnly: boolean; setNm: string | null; settingsLink: string }>();
const ed = useEditorStore();
const open = ref(true);
const included = computed(() => ed.defaultRows.filter((r) => r.included).length);
const excluded = computed(() => ed.defaultRows.length - included.value);
</script>

<template>
  <div :class="['default-cols', { 'is-collapsed': !open }]" data-testid="default-cols">
    <!-- 머리 줄 클릭 = 접기(마우스), 키보드·보조기기는 안의 버튼(링크를 품은 role=button은 중첩 상호작용 — CR-10 C5) -->
    <div class="default-cols-head" @click="open = !open">
      <button
        type="button"
        class="default-cols-toggle"
        :aria-expanded="open"
        aria-controls="default-cols-body"
      >
        <TfIcon name="chevron-down" class="chev" />
        <span class="fw-600">기본컬럼 {{ ed.defaultRows.length }}개</span>
      </button>
      <TfBadge v-if="setNm" kind="outline">세트 '{{ setNm }}'</TfBadge>
      <span class="text-sm text-muted"
        >하단에 자동 포함 · {{ included }} 포함 · {{ excluded }} 제외 · 개별 제외 가능</span
      >
      <span class="spacer" />
      <RouterLink class="text-sm" :to="settingsLink" @click.stop>프로젝트 설정</RouterLink>
    </div>
    <div id="default-cols-body" class="default-cols-body">
      <p v-if="ed.defaultRows.length === 0" class="text-sm text-muted card-pad">
        이 프로젝트는 기본컬럼을 자동 포함하지 않거나 기본 세트가 없습니다.
      </p>
      <table v-else class="grid" aria-label="기본컬럼">
        <thead>
          <tr>
            <th class="c-drag">포함</th>
            <th class="c-pk" />
            <th class="c-logical">논리명</th>
            <th class="c-phys">물리명</th>
            <th class="c-type">타입</th>
            <th class="c-null">NULL</th>
            <th class="c-def">기본값</th>
            <th class="c-comment">코멘트</th>
            <th class="c-code" />
            <th class="c-status" />
            <th class="c-menu" />
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in ed.defaultRows" :key="r.uid" :class="{ 'is-excluded': !r.included }">
            <td class="c-drag">
              <label class="check"
                ><input
                  type="checkbox"
                  :checked="r.included"
                  :disabled="readOnly"
                  :aria-label="`기본컬럼 ${r.physicalNm} 포함`"
                  @change="
                    ed.toggleDefault(r.uid, ($event.target as HTMLInputElement).checked)
                  " /><span class="check-box" aria-hidden="true"
              /></label>
            </td>
            <td />
            <td>{{ r.logicalNm }}</td>
            <td class="mono">{{ r.physicalNm }}</td>
            <td class="mono">{{ r.typeText }}</td>
            <td class="c-null">{{ r.isNullable ? 'Y' : 'N' }}</td>
            <td class="mono">{{ r.defaultVal }}</td>
            <td>{{ r.colComment }}</td>
            <td />
            <td>
              <TfBadge v-if="r.included" kind="default">기본컬럼</TfBadge>
              <TfBadge v-else kind="gray">제외</TfBadge>
            </td>
            <td />
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
