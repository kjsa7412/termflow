<script setup lang="ts">
import { computed } from 'vue';
import type { ValidationIssue } from '@termflow/shared';
import TfBadge from '../ui/TfBadge.vue';
import TfIcon from '../ui/TfIcon.vue';

/**
 * DDL 경고·오류 목록(목업 10 경고 카드, §6.10 `warnings[]`). 경고가 있어도 내보낼 수 있고, 오류(E)가 있는 테이블은
 * 서버가 생성을 거부한다(422) — `exclude`로 오류 테이블을 선택에서 뺄 수 있다.
 */
const props = withDefaults(
  defineProps<{ warnings: readonly ValidationIssue[]; errors?: readonly ValidationIssue[] }>(),
  { errors: () => [] },
);
const emit = defineEmits<{ exclude: [tableNms: string[]] }>();
const LABEL: Record<string, string> = {
  W_PK_NONE: 'PK 없음',
  W_SUFFIX_UNREGISTERED: '접미어',
  W_RESERVED_OTHER: '예약어(다른 방언)',
  W_LEN_OTHER_DIALECT: '길이(다른 방언)',
  W_DOMAIN_TYPE_CHANGED: '도메인 타입',
  W_DOMAIN_REVIEW: '검토 도메인',
  W_TERM_UNREGISTERED: '미등록 용어',
  W_TERM_PENDING: '검토대기 용어',
  W_TERM_REJECTED: '반려 용어',
  W_TERM_CHANGED: '표준 변경',
  W_CODE_CLS_MISSING: '코드구분',
  W_DEFAULT_AS_STRING: '기본값',
  W_COMMENT_EMPTY: '코멘트',
  W_PREFIX_MISMATCH: '접두어',
  W_VARCHAR_BYTES: '바이트',
  W_CONSTRAINT_NM_SHORTENED: '제약명',
  W_TYPE_OVERFLOW: '대체 타입',
};
const MAX = 100;
const rows = computed(() => [
  ...props.errors.map((i) => ({ ...i, err: true })),
  ...props.warnings.map((i) => ({ ...i, err: false })),
]);
const errorTables = computed(() => [
  ...new Set(props.errors.map((e) => e.tableNm).filter((x): x is string => Boolean(x))),
]);
</script>

<template>
  <div class="card card-flush" data-testid="ddl-warnings">
    <div class="card-header">
      <div class="card-title">
        <TfIcon name="alert-triangle" class="text-warning" />경고
        <span class="count-pill warning">{{ warnings.length }}</span>
        <span v-if="errors.length" class="count-pill danger">오류 {{ errors.length }}</span>
      </div>
      <span class="text-sm text-muted"
        >경고가 있어도 내보낼 수 있습니다 · 오류가 있는 테이블은 DDL을 만들 수 없습니다</span
      >
    </div>
    <div v-if="errorTables.length" class="alert alert-danger" role="alert">
      <TfIcon name="alert-circle" />
      <div class="alert-body">
        오류가 있는 테이블 {{ errorTables.length }}개:
        <span class="mono">{{ errorTables.join(', ') }}</span>
      </div>
      <div class="alert-actions">
        <button
          class="btn btn-secondary btn-sm"
          type="button"
          @click="emit('exclude', errorTables)"
        >
          오류 테이블 제외
        </button>
      </div>
    </div>
    <table v-if="rows.length" class="table table-compact">
      <thead>
        <tr>
          <th>구분</th>
          <th>테이블</th>
          <th>컬럼</th>
          <th>내용</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(w, i) in rows.slice(0, MAX)" :key="i">
          <td class="nowrap">
            <TfBadge :kind="w.err ? 'danger' : 'warning'" :title="w.code">{{
              w.err ? '오류' : (LABEL[w.code] ?? w.code)
            }}</TfBadge>
          </td>
          <td class="mono">{{ w.tableNm ?? '—' }}</td>
          <td class="mono">{{ w.columnNm ?? '' }}</td>
          <td>
            {{ w.message }} <span class="text-muted mono">{{ w.code }}</span>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-if="rows.length > MAX" class="table-footer">… {{ rows.length - MAX }}건 더</div>
    <div v-if="rows.length === 0" class="table-footer">경고 없음</div>
  </div>
</template>
