<script setup lang="ts">
import { computed, ref } from 'vue';
import type {
  ImportApplyResponse,
  ImportKind,
  ImportPreview,
  ImportRow,
  ImportRowStatus,
} from '@termflow/shared';
import { saveBlob } from '../../api/client.js';
import { standardsApi } from '../../api/standards.js';
import { errMsg, fmtNum } from '../../composables/useProject.js';
import { useToastStore } from '../../stores/toast.js';
import TfButton from '../ui/TfButton.vue';
import TfIcon from '../ui/TfIcon.vue';
import FilterSeg from './FilterSeg.vue';

/**
 * 일괄 등록 흐름(T6.11 BulkImportFlow, §9.4·§10.3, 목업 04b): 템플릿 → 업로드 → 색 구분 미리보기(신규 초록·갱신 파랑·오류 빨강·
 * 동일 회색) → 적용(오류 제외 옵션) → 결과. 미리보기 표는 서버 페이지(100행)로 넘긴다. S1 엑셀 계수: 클릭 3 / 이동 1.
 */
const props = defineProps<{ projectKey: string; kind: ImportKind; title: string }>();
const emit = defineEmits<{ done: [result: ImportApplyResponse]; cancel: [] }>();
const api = standardsApi();
const toast = useToastStore();

const step = ref<1 | 2 | 3>(1);
const busy = ref(false);
const error = ref<string | null>(null);
const preview = ref<ImportPreview | null>(null);
const result = ref<ImportApplyResponse | null>(null);
const filter = ref('');
const skipErrors = ref(true);
const dragging = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const PAGE = 100;

const STATUS: Record<ImportRowStatus, { label: string; cls: string }> = {
  NEW: { label: '신규', cls: 'badge-new' },
  UPDATE: { label: '갱신', cls: 'badge-update' },
  SKIP: { label: '동일', cls: 'badge-gray' },
  ERROR: { label: '오류', cls: 'badge-error' },
};

async function downloadTemplate(): Promise<void> {
  try {
    const r = await api.importTemplate(props.projectKey, props.kind);
    saveBlob(r.blob, r.fileName ?? `${props.title}_일괄등록_템플릿.xlsx`);
  } catch (e) {
    toast.error(errMsg(e, '템플릿을 내려받지 못했습니다'));
  }
}

async function upload(file: File | undefined): Promise<void> {
  if (!file) return;
  error.value = null;
  busy.value = true;
  try {
    if (preview.value)
      await api.cancelImport(props.projectKey, preview.value.importId).catch(() => undefined);
    preview.value = await api.upload(props.projectKey, props.kind, file);
    filter.value = '';
    step.value = 2;
  } catch (e) {
    error.value = errMsg(e, '파일을 읽지 못했습니다');
  } finally {
    busy.value = false;
    if (fileInput.value) fileInput.value.value = '';
  }
}
function onPick(e: Event): void {
  void upload((e.target as HTMLInputElement).files?.[0]);
}
function onDrop(e: DragEvent): void {
  dragging.value = false;
  void upload(e.dataTransfer?.files?.[0]);
}

async function loadPage(page: number): Promise<void> {
  if (!preview.value) return;
  busy.value = true;
  try {
    const q: Record<string, string | number> = { page, size: PAGE };
    if (filter.value === 'WARN') q['warn'] = 'true';
    else if (filter.value) q['status'] = filter.value;
    preview.value = await api.importPage(props.projectKey, preview.value.importId, q);
  } catch (e) {
    error.value = errMsg(e, '미리보기를 불러오지 못했습니다(30분이 지나면 다시 올려야 합니다)');
  } finally {
    busy.value = false;
  }
}

const s = computed(() => preview.value?.summary);
const applyCount = computed(() => (s.value ? s.value.new + s.value.update : 0));
const segs = computed(() =>
  s.value
    ? [
        { value: '', label: '전체', count: preview.value!.totalRows },
        { value: 'NEW', label: '신규', count: s.value.new },
        { value: 'UPDATE', label: '갱신', count: s.value.update },
        { value: 'SKIP', label: '동일', count: s.value.skip },
        { value: 'ERROR', label: '오류', count: s.value.error },
        { value: 'WARN', label: '경고', count: s.value.warn },
      ]
    : [],
);
const pageCount = computed(() =>
  preview.value ? Math.max(1, Math.ceil(preview.value.total / preview.value.size)) : 1,
);
const shown = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));
const changeText = (r: ImportRow) =>
  Object.entries(r.changes)
    .map(([k, [b, a]]) => `${label(k)}: ${shown(b)} → ${shown(a)}`)
    .join(' · ');
const label = (k: string) => preview.value?.columns.find((c) => c.key === k)?.label ?? k;

async function apply(): Promise<void> {
  if (!preview.value) return;
  busy.value = true;
  error.value = null;
  try {
    result.value = await api.applyImport(
      props.projectKey,
      preview.value.importId,
      skipErrors.value,
    );
    step.value = 3;
    const r = result.value;
    toast.success(
      `적용 완료 — 신규 ${fmtNum(r.applied.new)} · 갱신 ${fmtNum(r.applied.update)} · 오류 제외 ${fmtNum(r.errors)}`,
    );
    emit('done', r);
  } catch (e) {
    error.value = errMsg(e, '적용하지 못했습니다');
  } finally {
    busy.value = false;
  }
}

async function cancel(): Promise<void> {
  if (preview.value && step.value === 2)
    await api.cancelImport(props.projectKey, preview.value.importId).catch(() => undefined);
  emit('cancel');
}
</script>

<template>
  <div class="stack">
    <div class="row wrap">
      <div class="seg" aria-label="단계">
        <button type="button" :class="{ 'is-active': step === 1 }" disabled>
          <span class="count-pill">1</span> 파일 선택
        </button>
        <button type="button" :class="{ 'is-active': step === 2 }" disabled>
          <span class="count-pill">2</span> 미리보기
        </button>
        <button type="button" :class="{ 'is-active': step === 3 }" disabled>
          <span class="count-pill">3</span> 적용 결과
        </button>
      </div>
      <span class="spacer" />
      <TfButton variant="ghost" icon="file-text" @click="downloadTemplate"
        >템플릿 다운로드</TfButton
      >
    </div>

    <div v-if="error" class="alert alert-danger" role="alert">
      <TfIcon name="alert-circle" />
      <div class="alert-body">{{ error }}</div>
    </div>

    <div v-if="step !== 3" class="grid-2">
      <div class="card">
        <div class="card-header">
          <div class="card-title"><TfIcon name="upload" />파일</div>
        </div>
        <div v-if="preview" class="row wrap mb-2">
          <span class="file-chip"
            ><TfIcon name="file" />{{ preview.fileName
            }}<span class="text-muted">· {{ fmtNum(preview.totalRows) }}행</span></span
          >
        </div>
        <label
          :class="['dropzone', { 'is-active': dragging }]"
          data-testid="dropzone"
          @dragover.prevent="dragging = true"
          @dragleave="dragging = false"
          @drop.prevent="onDrop"
        >
          <input
            ref="fileInput"
            class="sr-only"
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            aria-label="xlsx 파일 선택"
            @change="onPick"
          />
          <span v-if="busy" class="spinner" aria-hidden="true" />
          <TfIcon v-else name="upload" size="lg" />
          <span>{{
            preview
              ? '다른 파일을 끌어다 놓거나 클릭'
              : '여기에 .xlsx를 끌어다 놓거나 클릭하여 선택'
          }}</span>
          <span class="text-sm">첫 행은 헤더(템플릿과 같은 순서) · 최대 20,000행</span>
        </label>
      </div>
      <div v-if="preview && s" class="card">
        <div class="card-header">
          <div class="card-title"><TfIcon name="check-circle" />검사 결과</div>
          <span class="text-sm text-muted">서버 검증 · {{ preview.elapsedMs }}ms</span>
        </div>
        <div class="grid-4" data-testid="summary">
          <div class="stat-card">
            <span class="stat-label">신규</span
            ><span class="stat-value text-success">{{ fmtNum(s.new) }}</span>
          </div>
          <div class="stat-card">
            <span class="stat-label">갱신</span
            ><span class="stat-value text-info">{{ fmtNum(s.update) }}</span>
          </div>
          <div class="stat-card">
            <span class="stat-label">동일</span><span class="stat-value">{{ fmtNum(s.skip) }}</span>
          </div>
          <div class="stat-card">
            <span class="stat-label">오류</span
            ><span class="stat-value text-danger">{{ fmtNum(s.error) }}</span
            ><span class="stat-sub">제외됩니다</span>
          </div>
        </div>
        <div class="divider" />
        <label class="check">
          <input v-model="skipErrors" type="checkbox" /><span class="check-box" />오류 행을 제외하고
          적용 <span class="text-muted">(끄면 오류가 있을 때 전체 취소)</span>
        </label>
        <p class="text-sm text-muted mt-2">
          빈 선택 칸은 기존 값을 유지합니다 · 적용하면 변경 이력(감사 IMPORT)에 행마다 기록됩니다
        </p>
      </div>
    </div>

    <template v-if="preview && step === 2">
      <div class="toolbar">
        <FilterSeg v-model="filter" :options="segs" label="행 필터" @change="loadPage(1)" />
        <span class="spacer" />
        <span class="text-sm text-muted">{{ preview.expiresAt.slice(11, 16) }}까지 보관</span>
      </div>
      <div class="table-wrap">
        <table class="table table-compact">
          <caption class="sr-only">
            일괄 등록 미리보기
          </caption>
          <thead>
            <tr>
              <th class="num">행</th>
              <th class="col-status">결과</th>
              <th v-for="c in preview.columns" :key="c.key" :class="{ 'text-muted': c.computed }">
                {{ c.label }}<span v-if="c.required" class="req" aria-hidden="true">*</span
                ><span v-if="c.computed" class="text-sm"> (계산)</span>
              </th>
              <th>사유 · 변경 내용</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="r in preview.items"
              :key="r.rowNo"
              :class="{ 'is-disabled': r.status === 'SKIP' }"
              :data-status="r.status"
            >
              <td class="num text-muted">{{ r.rowNo }}</td>
              <td>
                <span :class="['badge', STATUS[r.status].cls]">{{ STATUS[r.status].label }}</span>
              </td>
              <td
                v-for="c in preview.columns"
                :key="c.key"
                :class="{
                  mono: /Physical|physical|suffix|Cd$|codeCls$|code$|Prefix/.test(c.key),
                  'text-danger': r.errors.some((e) => e.field === c.key),
                  'text-2': c.computed,
                }"
              >
                {{ shown(r.values[c.key]) }}
              </td>
              <td class="text-sm">
                <span v-for="(e, i) in r.errors" :key="`e${i}`" class="text-danger d-block">{{
                  e.message
                }}</span>
                <span v-if="Object.keys(r.changes).length" class="text-info d-block">{{
                  changeText(r)
                }}</span>
                <span
                  v-for="(w, i) in r.warnings"
                  :key="`w${i}`"
                  :class="['d-block', w.code.startsWith('W_') ? 'text-warning' : 'text-muted']"
                  >{{ w.message }}</span
                >
              </td>
            </tr>
            <tr v-if="preview.items.length === 0">
              <td :colspan="preview.columns.length + 3" class="text-muted">해당 행이 없습니다</td>
            </tr>
          </tbody>
        </table>
        <nav class="pagination" aria-label="미리보기 페이지">
          <span class="info"
            >{{ fmtNum(preview.total) }}행 · {{ preview.page }}/{{ pageCount }} 페이지</span
          >
          <button
            class="page-btn"
            type="button"
            :disabled="preview.page <= 1 || busy"
            aria-label="이전 페이지"
            @click="loadPage(preview.page - 1)"
          >
            ‹
          </button>
          <button
            class="page-btn"
            type="button"
            :disabled="preview.page >= pageCount || busy"
            aria-label="다음 페이지"
            @click="loadPage(preview.page + 1)"
          >
            ›
          </button>
        </nav>
      </div>
      <div class="row mb-6">
        <TfButton variant="ghost" @click="cancel">취소</TfButton>
        <span class="spacer" />
        <span class="text-sm text-muted"
          >적용 시 신규 {{ fmtNum(s!.new) }} · 갱신 {{ fmtNum(s!.update) }} 등록, 오류
          {{ fmtNum(s!.error) }} 제외</span
        >
        <TfButton
          variant="primary"
          icon="check"
          :loading="busy"
          :disabled="applyCount === 0 || (!skipErrors && s!.error > 0)"
          @click="apply"
          >{{ fmtNum(applyCount) }}행 적용</TfButton
        >
      </div>
    </template>

    <div v-if="step === 3 && result" class="card" data-testid="import-result">
      <div class="alert alert-success">
        <TfIcon name="check-circle" />
        <div class="alert-body">
          <div class="alert-title">
            일괄 등록 완료 — 신규 {{ fmtNum(result.applied.new) }} · 갱신
            {{ fmtNum(result.applied.update) }} · 동일 {{ fmtNum(result.skipped) }} · 오류 제외
            {{ fmtNum(result.errors) }}
          </div>
          {{ preview?.fileName }} · 소요 {{ fmtNum(result.elapsedMs) }}ms · 변경 이력 묶음
          <span class="mono">{{ result.batchId.slice(0, 8) }}</span>
        </div>
        <div class="alert-actions">
          <TfButton variant="secondary" size="sm" @click="step = 1">다른 파일 올리기</TfButton>
          <TfButton variant="primary" size="sm" @click="emit('cancel')">목록으로</TfButton>
        </div>
      </div>
    </div>
  </div>
</template>
