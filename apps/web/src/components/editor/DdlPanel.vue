<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import {
  DDL_OPTIONS_DEFAULT,
  type DdlOptions,
  type Dialect,
  type ValidationIssue,
} from '@termflow/shared';
import { ApiError, saveBlob } from '../../api/client.js';
import { tablesApi, type TableCreateBody } from '../../api/tables.js';
import { useToastStore } from '../../stores/toast.js';
import DdlCode from '../ddl/DdlCode.vue';
import TfBadge from '../ui/TfBadge.vue';
import TfButton from '../ui/TfButton.vue';
import TfIcon from '../ui/TfIcon.vue';

/**
 * 편집기 우측 DDL 패널(설계서 §10.4, 목업 08 `aside.panel`, T8.11). 편집 본문을 500ms 디바운스 후 `POST P/ddl {draft}`로
 * 미리보기(서버 생성이 진실, 기록 없음). 오류(E)가 있으면 서버가 422로 거부 → 오류 목록만 보인다.
 * 경고 클릭 → 해당 행 포커스(rowIndex). [복사] = 클립보드 + 기록 COPY(저장본과 같을 때만, CR-06 §5), [.sql 다운로드] = 서버 파일.
 * S3 단일: [DDL](패널 열기) → [복사] = 클릭 2 / 이동 0.
 */
const props = defineProps<{
  projectKey: string;
  body: TableCreateBody;
  /** 저장된 테이블 ID(신규면 null). */
  tableId: number | null;
  /** 저장본과 같은지(복사 기록·다운로드를 저장본 기준으로). */
  saved: boolean;
  defaultDialect: Dialect;
}>();
const emit = defineEmits<{ close: []; focusRow: [rowIndex: number] }>();
const tapi = tablesApi();
const toast = useToastStore();

const dialect = ref<Dialect>(props.defaultDialect);
const options = ref<DdlOptions>({ ...DDL_OPTIONS_DEFAULT });
const sql = ref('');
const warnings = ref<ValidationIssue[]>([]);
const errors = ref<ValidationIssue[]>([]);
const loading = ref(false);
const failed = ref<string | null>(null);
const updatedAt = ref<string | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;
let ctrl: AbortController | null = null;

const request = () => ({
  ...(props.saved && props.tableId !== null
    ? { tableIds: [props.tableId] }
    : { draft: props.body }),
  dialect: dialect.value,
  options: options.value,
});

async function refresh(): Promise<void> {
  ctrl?.abort();
  const c = new AbortController();
  ctrl = c;
  loading.value = true;
  try {
    const r = await tapi.ddl(
      props.projectKey,
      { draft: props.body, dialect: dialect.value, options: options.value },
      c.signal,
    );
    if (c.signal.aborted) return;
    sql.value = r.sql;
    warnings.value = r.warnings;
    errors.value = [];
    failed.value = null;
  } catch (e) {
    if (c.signal.aborted) return;
    if (e instanceof ApiError && e.status === 422 && e.problem) {
      errors.value = (e.problem['errors'] as ValidationIssue[] | undefined) ?? [];
      warnings.value = (e.problem['warnings'] as ValidationIssue[] | undefined) ?? [];
      sql.value = '';
      failed.value = null;
    } else {
      failed.value = e instanceof ApiError ? e.message : '미리보기를 만들지 못했습니다';
    }
  } finally {
    if (ctrl === c) {
      loading.value = false;
      updatedAt.value = new Date().toTimeString().slice(0, 8);
    }
  }
}
function schedule(): void {
  clearTimeout(timer);
  timer = setTimeout(() => void refresh(), 500);
}
watch(() => [JSON.stringify(props.body), dialect.value, JSON.stringify(options.value)], schedule, {
  immediate: true,
});
onBeforeUnmount(() => {
  clearTimeout(timer);
  ctrl?.abort();
});

function setOpt<K extends keyof DdlOptions>(k: K, v: DdlOptions[K]): void {
  options.value = { ...options.value, [k]: v };
}

const warnColumns = computed(() =>
  warnings.value.map((w) => w.columnNm).filter((x): x is string => Boolean(x)),
);
const colCnt = computed(() => props.body.columns.length);
const canUse = computed(() => sql.value !== '' && errors.value.length === 0);

async function copy(): Promise<void> {
  if (!canUse.value) return;
  try {
    await navigator.clipboard.writeText(sql.value);
  } catch {
    toast.error('클립보드에 복사하지 못했습니다(브라우저 권한 확인)');
    return;
  }
  toast.success('DDL을 클립보드에 복사했습니다');
  if (props.saved && props.tableId !== null) {
    try {
      await tapi.recordCopy(props.projectKey, {
        kind: 'COPY',
        tableIds: [props.tableId],
        dialect: dialect.value,
        options: options.value,
        warningCnt: warnings.value.length,
      });
    } catch {
      /* 기록 실패는 복사를 막지 않는다 */
    }
  }
}
const downloading = ref(false);
async function download(): Promise<void> {
  if (!canUse.value) return;
  downloading.value = true;
  try {
    const f = await tapi.ddlFile(props.projectKey, request(), 'SQL');
    saveBlob(f.blob, f.fileName ?? `${props.body.table.tableNm || 'table'}.sql`);
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '다운로드하지 못했습니다');
  } finally {
    downloading.value = false;
  }
}
const focus = (i: ValidationIssue) => {
  if (i.rowIndex !== undefined) emit('focusRow', i.rowIndex);
};
defineExpose({ refresh });
</script>

<template>
  <aside class="panel" aria-label="DDL 미리보기 패널" data-testid="ddl-panel">
    <div class="panel-header">
      <TfIcon name="code" />DDL 미리보기
      <span v-if="loading" class="spinner" aria-label="갱신 중" />
      <span class="spacer" />
      <button
        class="btn btn-ghost btn-sm btn-icon"
        type="button"
        title="패널 닫기 (Ctrl+D)"
        aria-label="DDL 패널 닫기"
        @click="emit('close')"
      >
        <TfIcon name="x" />
      </button>
    </div>
    <div class="panel-body">
      <div class="panel-options">
        <div class="field">
          <label class="field-label" for="pn-dialect">방언</label>
          <select id="pn-dialect" v-model="dialect" class="select select-sm w-200">
            <option value="POSTGRESQL">
              PostgreSQL{{ defaultDialect === 'POSTGRESQL' ? ' (프로젝트 기본)' : '' }}
            </option>
          </select>
        </div>
        <div class="field">
          <label class="field-label" for="pn-schema">스키마명</label>
          <input
            id="pn-schema"
            class="input input-sm mono w-100"
            placeholder="(없음)"
            maxlength="63"
            :value="options.schemaName ?? ''"
            @change="
              setOpt(
                'schemaName',
                ($event.target as HTMLInputElement).value.trim().toUpperCase() || null,
              )
            "
          />
        </div>
        <div class="field">
          <span class="field-label">옵션</span>
          <div class="row">
            <label class="check"
              ><input
                type="checkbox"
                :checked="options.dropIfExists"
                @change="setOpt('dropIfExists', ($event.target as HTMLInputElement).checked)"
              /><span class="check-box" aria-hidden="true" />DROP IF EXISTS</label
            >
            <label class="check"
              ><input
                type="checkbox"
                :checked="options.includeComments"
                @change="setOpt('includeComments', ($event.target as HTMLInputElement).checked)"
              /><span class="check-box" aria-hidden="true" />코멘트 포함</label
            >
          </div>
        </div>
        <div class="field">
          <label class="field-label" for="pn-code">코드 표현</label>
          <select
            id="pn-code"
            class="select select-sm"
            :value="options.codeColumnStyle"
            @change="
              setOpt(
                'codeColumnStyle',
                ($event.target as HTMLSelectElement).value as DdlOptions['codeColumnStyle'],
              )
            "
          >
            <option value="COMMENT_SUMMARY">코멘트 요약</option>
            <option value="CHECK">CHECK 제약</option>
            <option value="NONE">표현 안 함</option>
          </select>
        </div>
      </div>

      <div v-if="failed" class="alert alert-danger" role="alert">
        <TfIcon name="alert-circle" />
        <div class="alert-body">
          {{ failed }}
          <button class="btn btn-ghost btn-sm" type="button" @click="refresh">다시 시도</button>
        </div>
      </div>
      <div v-else-if="errors.length > 0" class="alert alert-danger" data-testid="ddl-panel-errors">
        <TfIcon name="alert-circle" />
        <div class="alert-body">
          <div class="alert-title">
            오류 {{ errors.length }}건 — 오류를 해결하면 DDL이 만들어집니다
          </div>
          <ul class="validation-list plain">
            <li v-for="(e, i) in errors" :key="`e${i}`">
              <TfBadge kind="danger">오류</TfBadge>
              <button class="btn-link" type="button" @click="focus(e)">
                {{ e.rowIndex !== undefined ? `${e.rowIndex + 1}행 ` : '' }}{{ e.message }}
              </button>
            </li>
          </ul>
        </div>
      </div>
      <DdlCode v-else :sql="sql" :warn-columns="warnColumns" label="편집 중 DDL 미리보기" />

      <div class="section-title">
        경고 <span class="count-pill warning">{{ warnings.length }}</span>
      </div>
      <ul v-if="warnings.length > 0" class="validation-list plain" data-testid="ddl-panel-warnings">
        <li v-for="(w, i) in warnings" :key="`w${i}`">
          <TfBadge kind="warning">경고</TfBadge>
          <button
            class="btn-link"
            type="button"
            :disabled="w.rowIndex === undefined"
            @click="focus(w)"
          >
            {{ w.rowIndex !== undefined ? `${w.rowIndex + 1}행 ` : ''
            }}{{ w.columnNm ? `${w.columnNm}: ` : '' }}{{ w.message }}
          </button>
        </li>
      </ul>
      <p v-else class="text-sm text-muted">경고가 없습니다.</p>
    </div>
    <div class="panel-footer">
      <span
        >{{ updatedAt ? `마지막 갱신 ${updatedAt}` : '갱신 대기' }} · 컬럼 {{ colCnt
        }}{{ saved ? '' : ' · 저장 전 편집본' }}</span
      >
      <span class="spacer" />
      <TfButton variant="secondary" size="sm" icon="copy" :disabled="!canUse" @click="copy"
        >복사</TfButton
      >
      <TfButton
        variant="primary"
        size="sm"
        icon="download"
        :disabled="!canUse"
        :loading="downloading"
        :title="canUse ? undefined : '오류가 있어 다운로드할 수 없습니다'"
        @click="download"
        >.sql 다운로드</TfButton
      >
    </div>
  </aside>
</template>
