<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import {
  DDL_OPTIONS_DEFAULT,
  type BizAreaItem,
  type DdlExtractResponse,
  type DdlOptions,
  type DdlResponse,
  type Dialect,
  type ExportLogItem,
  type ValidationIssue,
} from '@termflow/shared';
import { saveBlob } from '../api/client.js';
import { projectsApi } from '../api/projects.js';
import { tablesApi, type DdlSelection } from '../api/tables.js';
import DdlCode from '../components/ddl/DdlCode.vue';
import DdlOptionsForm from '../components/ddl/DdlOptionsForm.vue';
import DdlWarnings from '../components/ddl/DdlWarnings.vue';
import SelectedTables from '../components/ddl/SelectedTables.vue';
import type { SelItem } from '../components/ddl/types.js';
import EmptyState from '../components/ui/EmptyState.vue';
import TfButton from '../components/ui/TfButton.vue';
import TfIcon from '../components/ui/TfIcon.vue';
import TfPopover from '../components/ui/TfPopover.vue';
import TfSkeleton from '../components/ui/TfSkeleton.vue';
import { errIssues, errMsg, fmtTs, useProject } from '../composables/useProject.js';
import { useToastStore } from '../stores/toast.js';

/**
 * DDL 내보내기(`/projects/{key}/export`, 목업 10, §10.1·§6.10·§6.11, T7.12). 좌: 선택 테이블(업무구분 다중 추가·검색 추가·순서)
 * + 옵션(§6.7), 우: DDL 미리보기(전체 / 테이블별 이동, 구문 강조) · 정보 추출(탭 구분) 탭, 경고, 최근 내보내기.
 * [복사]는 클립보드 + 기록(COPY), [다운로드]는 서버가 만든 .sql(DOWNLOAD)·.zip(ZIP) 파일. 미리보기는 기록하지 않는다.
 * 진입 쿼리: `?tableIds=1,2,3`(테이블 목록 선택) 또는 `?bizAreaIds=6`.
 */
const { key, project } = useProject();
const route = useRoute();
const tapi = tablesApi();
const papi = projectsApi();
const toast = useToastStore();

const selection = ref<SelItem[]>([]);
const bizAreas = ref<BizAreaItem[]>([]);
const options = ref<DdlOptions>({ ...DDL_OPTIONS_DEFAULT });
const dialect = ref<Dialect>('POSTGRESQL');
const result = ref<DdlResponse | null>(null);
const errors = ref<ValidationIssue[]>([]);
const errWarnings = ref<ValidationIssue[]>([]);
const loading = ref(false);
const notFound = ref(false);
const tab = ref<'ddl' | 'extract'>('ddl');
const view = ref<'all' | 'table'>('all');
const cursor = ref(0);
const extract = ref<DdlExtractResponse | null>(null);
const logs = ref<ExportLogItem[]>([]);
const busy = ref<string | null>(null);

const ids = computed(() => selection.value.map((t) => t.tableId));
const body = (): DdlSelection => ({
  tableIds: ids.value,
  dialect: dialect.value,
  options: options.value,
});

const parseIds = (v: unknown) =>
  String(Array.isArray(v) ? (v[0] ?? '') : (v ?? ''))
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);

async function tablesOfBiz(bizIds: number[]): Promise<SelItem[]> {
  const out: SelItem[] = [];
  for (const b of bizIds) {
    const r = await tapi.tables(key.value, { bizAreaId: b, size: 200, sort: 'tableNm,asc' });
    for (const t of r.items) {
      out.push({
        tableId: t.tableId,
        tableNm: t.tableNm,
        logicalNm: t.logicalNm,
        colCnt: t.colCnt,
        status: t.status,
        bizCd: t.bizCd,
        warningCnt: t.warningCnt,
        errorCnt: t.errorCnt,
      });
    }
  }
  return out;
}
function merge(items: SelItem[]): void {
  const have = new Set(ids.value);
  selection.value = [...selection.value, ...items.filter((t) => !have.has(t.tableId))];
}
async function addBiz(bizIds: number[]): Promise<void> {
  try {
    merge(await tablesOfBiz(bizIds));
  } catch (e) {
    toast.error(errMsg(e, '업무구분의 테이블을 불러오지 못했습니다'));
  }
}

/** 진입: 쿼리의 tableIds(순서 유지) → 미리보기 응답의 테이블 정보로 목록을 채운다. bizAreaIds는 목록 API로. */
async function init(): Promise<void> {
  if (!key.value) return;
  try {
    bizAreas.value = await papi.bizAreas(key.value);
  } catch (e) {
    if ((e as { status?: number }).status === 404) notFound.value = true;
    bizAreas.value = [];
  }
  const tIds = parseIds(route.query['tableIds']);
  const bIds = parseIds(route.query['bizAreaIds']);
  const items: SelItem[] = [];
  if (tIds.length > 0) {
    try {
      const r = await tapi.ddl(key.value, { tableIds: tIds, options: options.value });
      for (const t of r.tables) {
        items.push({
          tableId: t.tableId!,
          tableNm: t.tableNm,
          logicalNm: t.logicalNm,
          colCnt: t.colCnt,
          status: t.status,
          bizCd: t.bizCd,
          warningCnt: t.warningCnt,
        });
      }
    } catch (e) {
      // 오류 테이블이 섞여 있으면 목록 API로 정보만 채우고 미리보기가 오류를 보여 준다
      const r = await tapi.tables(key.value, { size: 200 }).catch(() => null);
      const byId = new Map((r?.items ?? []).map((t) => [t.tableId, t]));
      for (const id of tIds) {
        const t = byId.get(id);
        if (t)
          items.push({
            tableId: t.tableId,
            tableNm: t.tableNm,
            logicalNm: t.logicalNm,
            colCnt: t.colCnt,
            status: t.status,
            bizCd: t.bizCd,
            warningCnt: t.warningCnt,
            errorCnt: t.errorCnt,
          });
      }
      if (items.length === 0) toast.error(errMsg(e, '선택한 테이블을 불러오지 못했습니다'));
    }
  }
  selection.value = items;
  if (bIds.length > 0) await addBiz(bIds);
  void loadLogs();
}
watch(key, () => void init(), { immediate: true });

let timer: ReturnType<typeof setTimeout> | null = null;
let ctrl: AbortController | null = null;
async function refresh(): Promise<void> {
  ctrl?.abort();
  extract.value = null;
  if (ids.value.length === 0) {
    result.value = null;
    errors.value = [];
    errWarnings.value = [];
    return;
  }
  const c = new AbortController();
  ctrl = c;
  loading.value = true;
  try {
    result.value = await tapi.ddl(key.value, body(), c.signal);
    errors.value = [];
    errWarnings.value = [];
    cursor.value = Math.min(cursor.value, result.value.tables.length - 1);
    if (tab.value === 'extract') await loadExtract();
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return;
    result.value = null;
    errors.value = errIssues(e);
    errWarnings.value =
      (e as { problem?: { warnings?: ValidationIssue[] } }).problem?.warnings ?? [];
    if (errors.value.length === 0) toast.error(errMsg(e, 'DDL을 만들지 못했습니다'));
  } finally {
    if (ctrl === c) loading.value = false;
  }
}
watch(
  [ids, options, dialect],
  () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void refresh(), 300);
  },
  { deep: true },
);
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
  ctrl?.abort();
});

async function loadExtract(): Promise<void> {
  if (ids.value.length === 0) return;
  try {
    extract.value = await tapi.extract(key.value, body());
  } catch (e) {
    toast.error(errMsg(e, '정보 추출을 만들지 못했습니다'));
  }
}
watch(tab, (t) => {
  if (t === 'extract' && !extract.value) void loadExtract();
});

async function loadLogs(): Promise<void> {
  try {
    logs.value = (await tapi.exportLogs(key.value, { size: 5 })).items;
  } catch {
    logs.value = [];
  }
}

const current = computed(() => result.value?.tables[cursor.value] ?? null);
const shownSql = computed(() =>
  view.value === 'all' ? (result.value?.sql ?? '') : (current.value?.sql ?? ''),
);
const lineCnt = computed(() => (result.value?.sql.match(/\n/g) ?? []).length);
const warnColumns = computed(() =>
  (result.value?.warnings ?? [])
    .filter((w) => w.columnNm && (view.value === 'all' || w.tableNm === current.value?.tableNm))
    .map((w) => w.columnNm!),
);
const canExport = computed(
  () => result.value !== null && errors.value.length === 0 && !loading.value,
);

async function copy(text: string, tableIds: number[], kind: 'COPY' | 'EXTRACT', warnCnt: number) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    toast.error('클립보드에 복사하지 못했습니다(브라우저 권한 확인)');
    return;
  }
  try {
    await tapi.recordCopy(key.value, {
      kind,
      tableIds,
      dialect: dialect.value,
      options: options.value,
      warningCnt: warnCnt,
    });
  } catch {
    /* 기록 실패는 복사 결과에 영향 없음 */
  }
  void loadLogs();
}
async function copyAll(): Promise<void> {
  if (!result.value) return;
  await copy(result.value.sql, ids.value, 'COPY', result.value.warnings.length);
  toast.success(`DDL ${result.value.tableCnt}개 테이블을 클립보드에 복사했습니다`);
}
async function copyOne(): Promise<void> {
  const t = current.value;
  if (!t?.tableId) return;
  await copy(t.sql, [t.tableId], 'COPY', t.warningCnt);
  toast.success(`${t.tableNm} DDL을 복사했습니다`);
}
async function copyExtract(): Promise<void> {
  if (!extract.value) return;
  await copy(extract.value.text, ids.value, 'EXTRACT', 0);
  toast.success(`탭 구분 텍스트 ${extract.value.rowCnt}행을 복사했습니다`);
}
async function download(output: 'SQL' | 'ZIP'): Promise<void> {
  busy.value = output;
  try {
    const r = await tapi.ddlFile(key.value, body(), output);
    saveBlob(r.blob, r.fileName ?? `${key.value}_ddl.${output === 'ZIP' ? 'zip' : 'sql'}`);
    toast.success(`${r.fileName ?? '파일'} 다운로드`);
    void loadLogs();
  } catch (e) {
    toast.error(errMsg(e, '다운로드하지 못했습니다'));
  } finally {
    busy.value = null;
  }
}
async function downloadExtract(): Promise<void> {
  busy.value = 'TSV';
  try {
    const r = await tapi.extractFile(key.value, body());
    saveBlob(r.blob, r.fileName ?? `${key.value}_tables.tsv`);
    void loadLogs();
  } catch (e) {
    toast.error(errMsg(e, '다운로드하지 못했습니다'));
  } finally {
    busy.value = null;
  }
}
const primaryOutput = computed<'SQL' | 'ZIP'>(() =>
  options.value.fileSplit === 'PER_TABLE' ? 'ZIP' : 'SQL',
);
function excludeTables(names: string[]): void {
  selection.value = selection.value.filter((t) => !names.includes(t.tableNm));
}
async function again(l: ExportLogItem): Promise<void> {
  try {
    const r = await tapi.tables(key.value, { size: 200 });
    const byId = new Map(r.items.map((t) => [t.tableId, t]));
    selection.value = l.tableIds
      .map((id) => byId.get(id))
      .filter((t): t is NonNullable<typeof t> => Boolean(t))
      .map((t) => ({
        tableId: t.tableId,
        tableNm: t.tableNm,
        logicalNm: t.logicalNm,
        colCnt: t.colCnt,
        status: t.status,
        bizCd: t.bizCd,
        warningCnt: t.warningCnt,
        errorCnt: t.errorCnt,
      }));
  } catch (e) {
    toast.error(errMsg(e, '다시 불러오지 못했습니다'));
  }
}
const KIND_LABEL: Record<string, string> = {
  COPY: '복사',
  DOWNLOAD: '.sql',
  ZIP: '.zip',
  EXTRACT: '정보 추출',
};
</script>

<template>
  <EmptyState v-if="notFound" icon="folder" title="프로젝트를 찾을 수 없습니다">
    <RouterLink class="btn btn-secondary" to="/projects">프로젝트 목록으로</RouterLink>
  </EmptyState>
  <template v-else>
    <div class="page-header">
      <div>
        <div class="breadcrumb">
          <RouterLink :to="`/projects/${key}`">{{ project?.nm ?? key }}</RouterLink
          ><span>›</span><span>DDL 내보내기</span>
        </div>
        <h1 class="page-title">DDL 내보내기</h1>
        <p class="page-desc">
          서버가 방언별로 DDL을 생성합니다(P4). 각 테이블의 <strong>마지막 저장 버전</strong>을
          기준으로 하며, 누가·언제·어느 테이블을 어느 방언으로 내보냈는지 기록됩니다(미리보기 제외).
        </p>
      </div>
      <div class="page-actions">
        <TfButton icon="copy" :disabled="!canExport" @click="copyAll">복사</TfButton>
        <div class="btn-group">
          <TfButton
            variant="primary"
            icon="download"
            :disabled="!canExport"
            :loading="busy === primaryOutput"
            data-testid="download-primary"
            @click="download(primaryOutput)"
            >다운로드 {{ primaryOutput === 'ZIP' ? '.zip' : '.sql' }}</TfButton
          >
          <TfPopover align="right">
            <template #trigger="{ toggle, open, menuId }">
              <button
                class="btn btn-primary btn-icon"
                type="button"
                aria-label="다운로드 형식 선택"
                aria-haspopup="menu"
                :aria-expanded="open"
                :aria-controls="menuId"
                :disabled="!canExport"
                @click="toggle"
              >
                <TfIcon name="chevron-down" />
              </button>
            </template>
            <template #default="{ close }">
              <button
                class="dropdown-item"
                type="button"
                role="menuitem"
                @click="(close(), download('SQL'))"
              >
                <TfIcon name="file-text" />.sql — 단일 파일 ({{ ids.length }}개 테이블)
              </button>
              <button
                class="dropdown-item"
                type="button"
                role="menuitem"
                @click="(close(), download('ZIP'))"
              >
                <TfIcon name="zip" />.zip — 테이블별 파일 {{ ids.length }}개(업무구분 폴더)
              </button>
            </template>
          </TfPopover>
        </div>
      </div>
    </div>

    <div class="split">
      <div class="stack">
        <SelectedTables
          v-model="selection"
          :project-key="key"
          :biz-areas="bizAreas"
          @add-biz="addBiz"
        />
        <DdlOptionsForm
          v-model:options="options"
          v-model:dialect="dialect"
          default-dialect="POSTGRESQL"
          @refresh="refresh"
          @reset="options = { ...DDL_OPTIONS_DEFAULT }"
        />
      </div>

      <div class="stack">
        <EmptyState
          v-if="selection.length === 0"
          icon="table"
          title="내보낼 테이블을 고르세요"
          desc="왼쪽 [업무구분] 또는 [추가]로 테이블을 고르거나, 테이블 목록에서 체크한 뒤 내보내기로 오세요."
        >
          <div class="row">
            <button
              v-for="b in bizAreas.filter((x) => x.tableCnt > 0)"
              :key="b.bizAreaId"
              class="btn btn-secondary btn-sm"
              type="button"
              @click="addBiz([b.bizAreaId])"
            >
              {{ b.bizCd }} {{ b.bizNm }} 전체 ({{ b.tableCnt }})
            </button>
            <RouterLink class="btn btn-ghost btn-sm" :to="`/projects/${key}/tables`"
              ><TfIcon name="table" />테이블 목록</RouterLink
            >
          </div>
        </EmptyState>
        <template v-else>
          <div>
            <div class="tabs" role="tablist">
              <button
                :class="['tab', { 'is-active': tab === 'ddl' }]"
                type="button"
                role="tab"
                :aria-selected="tab === 'ddl'"
                @click="tab = 'ddl'"
              >
                <TfIcon name="code" />DDL 미리보기
              </button>
              <button
                :class="['tab', { 'is-active': tab === 'extract' }]"
                type="button"
                role="tab"
                :aria-selected="tab === 'extract'"
                @click="tab = 'extract'"
              >
                <TfIcon name="list" />정보 추출 (탭 구분)
              </button>
            </div>

            <div v-if="tab === 'ddl'" class="tab-panel is-active" role="tabpanel">
              <div class="code-toolbar">
                <div class="seg" role="group" aria-label="미리보기 범위">
                  <button
                    type="button"
                    :class="{ 'is-active': view === 'all' }"
                    :aria-pressed="view === 'all'"
                    @click="view = 'all'"
                  >
                    전체
                  </button>
                  <button
                    type="button"
                    :class="{ 'is-active': view === 'table' }"
                    :aria-pressed="view === 'table'"
                    @click="view = 'table'"
                  >
                    테이블별
                  </button>
                </div>
                <template v-if="view === 'table' && result">
                  <span
                    >미리보기: <strong class="mono text-2">{{ current?.tableNm }}</strong> ({{
                      cursor + 1
                    }}
                    / {{ result.tables.length }})</span
                  >
                  <button
                    class="btn btn-ghost btn-sm btn-icon"
                    type="button"
                    aria-label="이전 테이블"
                    :disabled="cursor <= 0"
                    @click="cursor--"
                  >
                    <TfIcon name="chevron-left" />
                  </button>
                  <button
                    class="btn btn-ghost btn-sm btn-icon"
                    type="button"
                    aria-label="다음 테이블"
                    :disabled="cursor >= result.tables.length - 1"
                    @click="cursor++"
                  >
                    <TfIcon name="chevron-right" />
                  </button>
                </template>
                <span class="spacer" />
                <span v-if="result"
                  >{{ result.tableCnt }}개 테이블 · 전체 {{ lineCnt.toLocaleString('ko-KR') }}줄 ·
                  PostgreSQL</span
                >
                <button
                  v-if="view === 'table' && current"
                  class="btn btn-ghost btn-sm"
                  type="button"
                  @click="copyOne"
                >
                  <TfIcon name="copy" />이 테이블만 복사
                </button>
              </div>
              <TfSkeleton v-if="loading && !result" :lines="8" />
              <DdlCode v-else-if="result" :sql="shownSql" :warn-columns="warnColumns" />
              <div v-else-if="errors.length" class="alert alert-danger">
                <TfIcon name="alert-circle" />
                <div class="alert-body">
                  오류가 있어 DDL을 만들 수 없습니다. 아래 목록에서 오류 테이블을 제외하거나
                  옵션(인용 식별자 등)을 바꾸세요.
                </div>
              </div>
            </div>

            <div v-else class="tab-panel is-active" role="tabpanel">
              <div class="code-toolbar">
                <span>탭 구분 텍스트 — 엑셀에 붙여넣어 테이블 정의서로 사용</span>
                <span class="spacer" />
                <span v-if="extract">{{ extract.rowCnt.toLocaleString('ko-KR') }}행</span>
                <button
                  class="btn btn-ghost btn-sm"
                  type="button"
                  :disabled="!extract"
                  @click="copyExtract"
                >
                  <TfIcon name="copy" />복사
                </button>
                <TfButton
                  variant="ghost"
                  size="sm"
                  icon="download"
                  :disabled="!extract"
                  :loading="busy === 'TSV'"
                  @click="downloadExtract"
                  >.tsv 다운로드</TfButton
                >
              </div>
              <TfSkeleton v-if="!extract" :lines="6" />
              <pre v-else class="code code-tab" data-testid="extract-text" tabindex="0">{{
                extract.text
              }}</pre>
            </div>
          </div>

          <DdlWarnings
            :warnings="result?.warnings ?? errWarnings"
            :errors="errors"
            @exclude="excludeTables"
          />
        </template>

        <div class="card card-flush">
          <div class="card-header">
            <div class="card-title"><TfIcon name="history" />최근 내보내기</div>
          </div>
          <table v-if="logs.length" class="table table-compact">
            <thead>
              <tr>
                <th>일시</th>
                <th>사용자</th>
                <th>테이블</th>
                <th>방언</th>
                <th>형식</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr v-for="l in logs" :key="l.exportId">
                <td class="nowrap">{{ fmtTs(l.exportedAt) }}</td>
                <td>{{ l.exportedByNm ?? l.exportedBy }}</td>
                <td>
                  {{ l.tableCnt }}개<span v-if="l.firstTableNm" class="mono text-muted">
                    ({{ l.firstTableNm }}{{ l.tableCnt > 1 ? ' 외' : '' }})</span
                  >
                </td>
                <td>{{ l.dialect === 'POSTGRESQL' ? 'PostgreSQL' : l.dialect }}</td>
                <td>{{ KIND_LABEL[l.outputKind] ?? l.outputKind }}</td>
                <td class="col-menu">
                  <button class="btn btn-ghost btn-sm" type="button" @click="again(l)">다시</button>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-else class="table-footer">아직 내보낸 기록이 없습니다</div>
        </div>
      </div>
    </div>
  </template>
</template>
