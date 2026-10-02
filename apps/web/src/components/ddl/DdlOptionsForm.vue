<script setup lang="ts">
import type { DdlOptions, Dialect } from '@termflow/shared';
import TfIcon from '../ui/TfIcon.vue';

/**
 * DDL 옵션(§6.7, 목업 10 옵션 카드): 방언(D2: PostgreSQL만) · 스키마명 · DROP IF EXISTS · 코멘트 · 대소문자 · 인용 ·
 * 파일 분할 · 코드성 컬럼 표현(D14) · 줄바꿈 · 헤더. 기본값은 D15(대문자·스키마 없음·DROP 없음·코멘트 포함·비인용).
 */
const options = defineModel<DdlOptions>('options', { required: true });
const dialect = defineModel<Dialect>('dialect', { required: true });
defineProps<{ defaultDialect: Dialect }>();
const emit = defineEmits<{ refresh: []; reset: [] }>();
function set<K extends keyof DdlOptions>(k: K, v: DdlOptions[K]): void {
  options.value = { ...options.value, [k]: v };
}
function onSchema(e: Event): void {
  const v = (e.target as HTMLInputElement).value.trim();
  set('schemaName', v === '' ? null : v.toUpperCase());
}
</script>

<template>
  <div class="card" data-testid="ddl-options">
    <div class="card-header">
      <div class="card-title"><TfIcon name="settings" />옵션</div>
      <button class="btn btn-ghost btn-sm" type="button" @click="emit('reset')">기본값으로</button>
    </div>
    <div class="stack">
      <div class="field">
        <label class="field-label" for="ex-dialect">방언</label>
        <select id="ex-dialect" v-model="dialect" class="select">
          <option value="POSTGRESQL">
            PostgreSQL{{ defaultDialect === 'POSTGRESQL' ? ' (프로젝트 기본)' : '' }}
          </option>
        </select>
        <span class="field-help">현재는 PostgreSQL만 지원합니다.</span>
      </div>
      <div class="field">
        <label class="field-label" for="ex-schema">스키마명 접두</label>
        <input
          id="ex-schema"
          class="input mono"
          placeholder="(없음) 예: rp"
          maxlength="63"
          :value="options.schemaName ?? ''"
          @change="onSchema"
        />
        <span class="field-help"
          >입력 시 <span class="mono">{{ options.schemaName ?? 'RP' }}.RP_…</span> 형식으로
          생성</span
        >
      </div>
      <div class="field">
        <span class="field-label">포함</span>
        <div class="stack-sm">
          <label class="check"
            ><input
              type="checkbox"
              :checked="options.dropIfExists"
              @change="set('dropIfExists', ($event.target as HTMLInputElement).checked)"
            /><span class="check-box" />DROP TABLE IF EXISTS 앞에 추가</label
          >
          <label class="check"
            ><input
              type="checkbox"
              :checked="options.includeComments"
              @change="set('includeComments', ($event.target as HTMLInputElement).checked)"
            /><span class="check-box" />COMMENT ON TABLE / COLUMN 포함</label
          >
          <label class="check"
            ><input
              type="checkbox"
              :checked="options.includeHeader"
              @change="set('includeHeader', ($event.target as HTMLInputElement).checked)"
            /><span class="check-box" />상단 생성 정보 주석</label
          >
        </div>
      </div>
      <div class="field">
        <span class="field-label">식별자</span>
        <div class="row wrap">
          <label class="check radio"
            ><input
              type="radio"
              name="ex-case"
              :checked="options.identifierCase === 'UPPER'"
              @change="set('identifierCase', 'UPPER')"
            /><span class="check-box" />대문자</label
          >
          <label class="check radio"
            ><input
              type="radio"
              name="ex-case"
              :checked="options.identifierCase === 'LOWER'"
              @change="set('identifierCase', 'LOWER')"
            /><span class="check-box" />소문자</label
          >
          <label class="check" title="대소문자 보존 — 이후 모든 질의에서 인용이 필요합니다"
            ><input
              type="checkbox"
              :checked="options.quoteIdentifiers"
              @change="set('quoteIdentifiers', ($event.target as HTMLInputElement).checked)"
            /><span class="check-box" />인용("…")</label
          >
        </div>
      </div>
      <div class="field">
        <span class="field-label">파일 분할</span>
        <div class="row">
          <label class="check radio"
            ><input
              type="radio"
              name="ex-split"
              :checked="options.fileSplit === 'SINGLE'"
              @change="set('fileSplit', 'SINGLE')"
            /><span class="check-box" />단일 .sql</label
          >
          <label class="check radio"
            ><input
              type="radio"
              name="ex-split"
              :checked="options.fileSplit === 'PER_TABLE'"
              @change="set('fileSplit', 'PER_TABLE')"
            /><span class="check-box" />테이블별 .zip</label
          >
        </div>
      </div>
      <div class="field">
        <label class="field-label" for="ex-code">코드성 컬럼 표현</label>
        <select
          id="ex-code"
          class="select"
          :value="options.codeColumnStyle"
          @change="
            set(
              'codeColumnStyle',
              ($event.target as HTMLSelectElement).value as DdlOptions['codeColumnStyle'],
            )
          "
        >
          <option value="COMMENT_SUMMARY">코멘트에 코드값 요약</option>
          <option value="CHECK">CHECK 제약</option>
          <option value="NONE">없음</option>
        </select>
      </div>
      <div class="field">
        <label class="field-label" for="ex-eol">줄바꿈</label>
        <select
          id="ex-eol"
          class="select"
          :value="options.lineEnding"
          @change="
            set(
              'lineEnding',
              ($event.target as HTMLSelectElement).value as DdlOptions['lineEnding'],
            )
          "
        >
          <option value="LF">LF</option>
          <option value="CRLF">CRLF(Windows)</option>
        </select>
      </div>
      <button class="btn btn-secondary" type="button" @click="emit('refresh')">
        <TfIcon name="refresh" />미리보기 갱신
      </button>
    </div>
  </div>
</template>
