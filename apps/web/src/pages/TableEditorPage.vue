<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import {
  AUTOCOMPLETE_BATCH_MAX,
  MEMBER_ROLE_RANK,
  normalizeLogical,
  type AutocompleteSegment,
  type BizAreaItem,
  type DefaultColItem,
  type DefaultColSetItem,
  type Dialect,
  type ProjectSettings,
  type TableCloneResponse,
  type TableConflict,
  type ValidationIssue,
} from '@termflow/shared';
import { autocompleteApi } from '../api/autocomplete.js';
import { ApiError } from '../api/client.js';
import { projectsApi } from '../api/projects.js';
import { standardsApi } from '../api/standards.js';
import { tablesApi, type TableCreateBody } from '../api/tables.js';
import ClonePopover from '../components/editor/ClonePopover.vue';
import ColumnCompare from '../components/editor/ColumnCompare.vue';
import ColumnGrid from '../components/editor/ColumnGrid.vue';
import DdlPanel from '../components/editor/DdlPanel.vue';
import DefaultColsArea from '../components/editor/DefaultColsArea.vue';
import HistoryPanel from '../components/editor/HistoryPanel.vue';
import ConflictMergeModal from '../components/ui/ConflictMergeModal.vue';
import EmptyState from '../components/ui/EmptyState.vue';
import TfBadge from '../components/ui/TfBadge.vue';
import TfButton from '../components/ui/TfButton.vue';
import TfIcon from '../components/ui/TfIcon.vue';
import TfPopover from '../components/ui/TfPopover.vue';
import TfSkeleton from '../components/ui/TfSkeleton.vue';
import { errIssues, errMsg, fmtTs, useProject } from '../composables/useProject.js';
import { alignColumns, diffCount } from '../editor/compare.js';
import {
  draftKey,
  loadDraft,
  removeDraft,
  sameContent,
  saveDraft,
  type EditorDraft,
} from '../editor/draft-storage.js';
import { needsAutocomplete, useEditorStore, type EditorRow } from '../stores/editor.js';
import { useToastStore } from '../stores/toast.js';
import SegmentPieces from '../components/editor/SegmentPieces.vue';

/**
 * 테이블 설계 편집기(`/projects/{key}/tables/new`, `/{id}`, 목업 08·14, 설계서 §10.4·§8, T8.8~T8.14).
 * 헤더(업무구분·논리명·물리명·설명·상태·[저장 Ctrl+S][DDL Ctrl+D][이력][복제]) / 검증 요약 바 / 컬럼 그리드 / 기본컬럼 영역 /
 * 우측 패널(DDL 미리보기 또는 이력). 편집 변경은 500ms 디바운스로 서버 검증(`tables/validate`)·DDL 미리보기를 갱신하고,
 * 1초 디바운스로 localStorage 임시저장(§8.7). 409는 충돌 병합 모달(모달 2/2), 그 외 보조 UI는 팝오버·패널(G9).
 * 읽기 전용: 조회자 · 보관 프로젝트 · FINAL(배너, 프로젝트 관리자에게 [확정 해제]).
 */
const { key, project, session } = useProject();
const route = useRoute();
const router = useRouter();
const ed = useEditorStore();
const tapi = tablesApi();
const papi = projectsApi();
const sapi = standardsApi();
const acapi = autocompleteApi();
const toast = useToastStore();

const loading = ref(true);
const notFound = ref(false);
const loadError = ref<string | null>(null);
const bizAreas = ref<BizAreaItem[]>([]);
const settings = ref<ProjectSettings | null>(null);
const defaultSet = ref<DefaultColSetItem | null>(null);
const setCols = computed<DefaultColItem[]>(() => defaultSet.value?.columns ?? []);
const grid = ref<InstanceType<typeof ColumnGrid> | null>(null);
const saving = ref(false);
const statusBusy = ref(false);
const unfinalizeNote = ref('');
const draftSavedAt = ref<string | null>(null);
/** 물리 테이블명 자동 제안 상태(§5.5 `nmAuto`): 새 테이블 true, 사용자가 물리명을 직접 고치면 false. */
const nmAuto = ref(false);
const nameSegs = ref<AutocompleteSegment[]>([]);
/** 마지막 자동완성 응답의 캐시 버전(임시저장 `cacheVersion`, CR-07 §4). */
const lastCacheVersion = ref<number | null>(null);

const isNew = computed(() => route.name === 'table-new');
const routeId = computed(() => (isNew.value ? null : Number(route.params['tableId'])));
const draftId = computed(() => String(route.query['draft'] ?? ''));
const dKey = computed(() =>
  ed.tableId !== null ? draftKey(key.value, ed.tableId) : draftKey(key.value, draftId.value || 'x'),
);

// ── 권한·읽기 전용(§7.3, §10.5) ───────────────────────────────────
const role = computed(() => (session.isSysAdmin ? 'ADMIN' : (project.value?.role ?? 'VIEWER')));
const canEditRole = computed(() => MEMBER_ROLE_RANK[role.value] >= MEMBER_ROLE_RANK.EDITOR);
const isAdmin = computed(() => role.value === 'ADMIN');
const archived = computed(() => project.value?.status === 'ARCHIVED');
const final = computed(() => ed.status === 'FINAL');
const readOnly = computed(() => !canEditRole.value || archived.value || final.value);
const dialect = computed<Dialect>(() => settings.value?.defaultDialect ?? 'POSTGRESQL');
const biz = computed(() => bizAreas.value.find((b) => b.bizAreaId === ed.header.bizAreaId) ?? null);

// ── 우측 패널(DDL·이력) ─────────────────────────────────────────────
const PANEL_KEY = 'tf.editor.panel';
/** 1,500px보다 좁은 창은 처음 열 때 DDL 패널을 닫아 둔다 — 그리드가 반쯤 가려졌다(CR-15 C9). 한 번 열고 닫으면 그 선택을 따른다. */
const NARROW_FOR_PANEL = '(max-width: 1499px)';
function storedPanel(): 'ddl' | null {
  try {
    const v = localStorage.getItem(PANEL_KEY);
    if (v !== null) return v === '0' ? null : 'ddl';
  } catch {
    /* 저장소 없음 — 아래 기본값 */
  }
  return typeof window !== 'undefined' && window.matchMedia?.(NARROW_FOR_PANEL).matches
    ? null
    : 'ddl';
}
const panel = ref<'ddl' | 'history' | null>(storedPanel());
function setPanel(p: 'ddl' | 'history' | null): void {
  panel.value = p;
  try {
    if (p !== 'history') localStorage.setItem(PANEL_KEY, p === 'ddl' ? '1' : '0');
  } catch {
    /* 무시 */
  }
}
const toggleDdl = () => setPanel(panel.value === 'ddl' ? null : 'ddl');

// ── 로드 ────────────────────────────────────────────────────────────
const draftBanner = ref<{ draft: EditorDraft; newer: boolean } | null>(null);
/** 409 version-conflict 본문 + 보낸 내 편집본(충돌 병합 모달, §8.1). */
const conflict = ref<(TableConflict & { mine: TableCreateBody }) | null>(null);

async function loadContext(): Promise<void> {
  const [b, s] = await Promise.all([papi.bizAreas(key.value), papi.settings(key.value)]);
  bizAreas.value = b;
  settings.value = s;
  if (s.includeDefaultCols) {
    const sets = await sapi.defaultColSets(key.value);
    defaultSet.value =
      sets.find((x) => x.setId === s.defaultColSetId) ?? sets.find((x) => x.isDefault) ?? null;
  } else {
    defaultSet.value = null;
  }
}

function checkDraft(): void {
  const d = loadDraft(dKey.value);
  if (!d || sameContent(d, ed.payload)) {
    draftBanner.value = null;
    return;
  }
  draftBanner.value = {
    draft: d,
    newer: d.baseVersion !== null && ed.version !== null && d.baseVersion < ed.version,
  };
}

async function reloadDetail(): Promise<void> {
  if (ed.tableId === null && routeId.value === null) return;
  const d = await tapi.detail(key.value, ed.tableId ?? routeId.value!);
  ed.load(d, setCols.value);
}

async function init(): Promise<void> {
  if (!key.value) return;
  if (isNew.value && !draftId.value) {
    // 새 테이블 임시저장 키(new-<uuid>)가 새로고침·재로그인 뒤에도 같도록 URL에 둔다(§8.7)
    const id =
      globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await router.replace({ query: { ...route.query, draft: id } });
    return;
  }
  loading.value = true;
  notFound.value = false;
  loadError.value = null;
  conflict.value = null;
  ed.reset(key.value);
  try {
    await loadContext();
    if (isNew.value) {
      const want = Number(route.query['bizAreaId']);
      const b =
        bizAreas.value.find((x) => x.bizAreaId === want && x.useYn) ??
        bizAreas.value.find((x) => x.useYn) ??
        null;
      ed.initNew(key.value, {
        bizAreaId: b?.bizAreaId ?? null,
        prefix: b?.tablePrefix ?? null,
        defaultSet: setCols.value,
      });
      nmAuto.value = true;
    } else {
      await reloadDetail();
      nmAuto.value = false;
    }
    nameSegs.value = [];
    checkDraft();
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound.value = true;
    else loadError.value = errMsg(e, '테이블을 불러오지 못했습니다');
  } finally {
    loading.value = false;
  }
}
watch(
  () => [key.value, route.name, route.params['tableId'], draftId.value],
  () => void init(),
  { immediate: true },
);

// ── 임시저장(1초 디바운스, §8.7) ───────────────────────────────────
function persistDraft(): void {
  if (!ed.dirty) return;
  const now = new Date();
  const ok = saveDraft(dKey.value, {
    savedAt: now.toISOString(),
    baseVersion: ed.version,
    table: ed.payload.table,
    columns: ed.payload.columns,
    cacheVersion: lastCacheVersion.value,
  });
  if (ok) draftSavedAt.value = now.toTimeString().slice(0, 5);
}
let draftTimer: ReturnType<typeof setTimeout> | undefined;
let validateTimer: ReturnType<typeof setTimeout> | undefined;
let validateCtrl: AbortController | null = null;

// ── 서버 검증(500ms 디바운스, §10.4) ────────────────────────────────
/**
 * 요청할 만한 편집본인지(빈 새 테이블 결함 수정, CR-08 C9): 논리 테이블명이 비었거나 일반 컬럼이 없으면 검증·DDL 미리보기를
 * 부르지 않는다 — 논리 테이블명은 요청 형식상 필수라 빈 본문은 400이 되고, 패널에 "요청 형식 오류"가 떴다.
 */
const draftReady = computed(
  () =>
    ed.header.tableLogicalNm.trim() !== '' &&
    (ed.tableId !== null || ed.payload.columns.some((c) => c.defaultColId === null)),
);

async function validateNow(): Promise<void> {
  if (readOnly.value || loading.value) return;
  if (ed.header.tableLogicalNm.trim() === '') return;
  validateCtrl?.abort();
  const c = new AbortController();
  validateCtrl = c;
  const uids = ed.payloadRows.map((r) => r.uid);
  try {
    const r = await tapi.validate(
      key.value,
      { ...ed.payload, ...(ed.tableId !== null ? { tableId: ed.tableId } : {}) },
      c.signal,
    );
    if (!c.signal.aborted) ed.setServerIssues(r.errors, r.warnings, uids);
  } catch {
    /* 검증 실패는 저장 시 다시 확인된다 */
  }
}
watch(
  () => ed.payloadJson,
  () => {
    if (loading.value || readOnly.value || !ed.dirty) return;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(persistDraft, 1000);
    clearTimeout(validateTimer);
    validateTimer = setTimeout(() => void validateNow(), 500);
  },
);

// ── 자동완성(§5.3·§5.9·§10.4, T9.7·T9.8) ───────────────────────────
const AC_FAIL = '자동완성을 불러오지 못했습니다 — 물리명·타입을 직접 입력할 수 있습니다';
async function runAc(row: EditorRow, opts: { force?: boolean } = {}): Promise<void> {
  if (readOnly.value) return;
  const r0 = ed.find(row.uid);
  if (!r0 || r0.defaultColId !== null) return;
  if (!opts.force && !needsAutocomplete(r0)) return;
  const logical = r0.logicalNm;
  if (normalizeLogical(logical) === '') return;
  ed.beginLoading(row.uid);
  try {
    const res = await acapi.column(key.value, {
      logicalNm: logical,
      bizAreaId: ed.header.bizAreaId,
      excludeColumnId: r0.columnId,
    });
    const cur = ed.find(row.uid);
    // 응답을 기다리는 사이 논리명을 고쳤으면 적용하지 않는다(다음 Enter에 새로 부른다)
    if (!cur || cur.logicalNm !== logical) return ed.endLoading(row.uid);
    lastCacheVersion.value = res.cacheVersion;
    ed.applyAutocomplete(row.uid, res);
  } catch (e) {
    ed.endLoading(row.uid, errMsg(e, AC_FAIL));
  }
}

async function batchAc(rows: EditorRow[]): Promise<void> {
  const list = rows.filter((r) => normalizeLogical(r.logicalNm) !== '' && r.defaultColId === null);
  for (let i = 0; i < list.length; i += AUTOCOMPLETE_BATCH_MAX) {
    const chunk = list.slice(i, i + AUTOCOMPLETE_BATCH_MAX);
    const names = chunk.map((r) => r.logicalNm);
    chunk.forEach((r) => ed.beginLoading(r.uid));
    try {
      const res = await acapi.batch(key.value, {
        logicalNms: names,
        bizAreaId: ed.header.bizAreaId,
      });
      lastCacheVersion.value = res.cacheVersion;
      res.items.forEach((it, j) => {
        const r = ed.find(chunk[j]!.uid);
        if (r && r.logicalNm === names[j]) ed.applyAutocomplete(r.uid, it, { batch: true });
        else if (r) ed.endLoading(r.uid);
      });
    } catch (e) {
      chunk.forEach((r) => ed.endLoading(r.uid, errMsg(e, AC_FAIL)));
    }
  }
}

/** 인라인 등록(§5.9): PENDING 등록 → 같은 논리명 자동 재시도(G2: 입력 1~2 · 클릭 ≤1 · 이동 0). */
async function registerTerm(row: EditorRow): Promise<boolean> {
  const r = ed.find(row.uid);
  const reg = r?.ac?.reg;
  if (!r || !reg || reg.busy) return false;
  const physical = reg.physical.trim().toUpperCase();
  if (physical === '') {
    reg.error = '물리약어를 입력하세요';
    return false;
  }
  reg.busy = true;
  reg.error = null;
  try {
    const res = await acapi.inlineTerm(key.value, {
      termKor: reg.kor,
      termPhysical: physical,
      description: reg.description.trim() || null,
    });
    toast.success(
      res.outcome === 'EXISTING'
        ? `'${res.termKor}'은(는) 이미 있는 용어입니다(${res.termPhysical ?? '물리약어 없음'})`
        : `'${res.termKor}' ${res.termPhysical}을(를) 검토대기로 등록했습니다`,
    );
    if (res.conflicts.length > 0) {
      toast.info(
        `${res.termPhysical}은(는) ${res.conflicts.map((c) => `'${c.termKor}'`).join(', ')}와(과) 같은 물리약어입니다 — 동의어 후보로 표시됩니다`,
      );
    }
    await runAc(r, { force: true });
    return ed.find(row.uid)?.ac?.open == null;
  } catch (e) {
    reg.error = errMsg(e, '등록하지 못했습니다');
    return false;
  } finally {
    reg.busy = false;
  }
}

/** [재적용](§4.8): 같은 논리명으로 다시 자동완성해 바뀐 표준(물리명·도메인 타입)을 채운다. */
async function reapply(uid: string): Promise<void> {
  const r = ed.find(uid);
  if (r) await runAc(r, { force: true });
}

/** '도메인으로 등록'(§10.4 composed, 프로젝트 관리자): 조각(≤7)을 명칭 1~7로 도메인 등록(L1) → 재자동완성 → exact. */
async function registerDomain(uid: string): Promise<void> {
  let r = ed.find(uid);
  if (!r) return;
  if (!r.ac || r.ac.segments.length === 0) {
    await runAc(r, { force: true });
    r = ed.find(uid);
  }
  const segs = r?.ac?.segments ?? [];
  if (!r || segs.length === 0 || segs.length > 7 || segs.some((s) => !s.matched)) {
    toast.error('조각이 7개 이하이고 모두 등록된 용어일 때만 도메인으로 등록할 수 있습니다');
    return;
  }
  const nm = (i: number) => segs[i]?.kor ?? null;
  try {
    await sapi.createDomain(key.value, {
      nm1: nm(0),
      nm2: nm(1),
      nm3: nm(2),
      nm4: nm(3),
      nm5: nm(4),
      nm6: nm(5),
      nm7: nm(6),
      typeSource: 'AUTO',
      colType: null,
      colLength: null,
      colScale: null,
    });
    toast.success(`'${r.logicalNm}'을(를) 표준 도메인으로 등록했습니다`);
    await runAc(r, { force: true });
  } catch (e) {
    toast.error(errMsg(e, '도메인으로 등록하지 못했습니다'));
  }
}

ed.autocomplete = runAc;
ed.batchAutocomplete = batchAc;
ed.registerTerm = registerTerm;
onBeforeUnmount(() => {
  ed.autocomplete = null;
  ed.batchAutocomplete = null;
  ed.registerTerm = null;
});

// ── 물리 테이블명 자동 제안(§5.5, T9.5) ────────────────────────────
let suggestCtrl: AbortController | null = null;
async function suggestName(): Promise<void> {
  if (readOnly.value || !nmAuto.value) return;
  const logical = ed.header.tableLogicalNm.trim();
  if (logical === '') return;
  suggestCtrl?.abort();
  const c = new AbortController();
  suggestCtrl = c;
  try {
    const r = await acapi.suggestName(
      key.value,
      {
        logicalNm: logical,
        bizAreaId: ed.header.bizAreaId,
        ...(ed.tableId !== null ? { tableId: ed.tableId } : {}),
      },
      c.signal,
    );
    if (c.signal.aborted || !nmAuto.value) return;
    ed.header.tableNm = r.tableNm;
    nameSegs.value = r.segments;
  } catch {
    /* 제안 실패는 수동 입력으로 이어간다 */
  }
}
function onPhysInput(): void {
  nmAuto.value = false;
  nameSegs.value = [];
}

// ── 저장·충돌(§8.1) ─────────────────────────────────────────────────
const conflictDiff = computed(() =>
  conflict.value
    ? diffCount(alignColumns(conflict.value.current.columns, conflict.value.mine.columns))
    : 0,
);

async function focusIssue(i: { uid: string | null; field?: string | undefined }): Promise<void> {
  if (i.uid) return grid.value?.focusCell(i.uid, i.field ?? 'logicalNm');
  const id =
    i.field === 'bizAreaId' ? 'ed-biz' : i.field === 'tableLogicalNm' ? 'ed-logical' : 'ed-phys';
  document.getElementById(id)?.focus();
}
function focusFirstError(): void {
  const e = ed.errors[0];
  if (e) void focusIssue(e);
}
function focusRowIndex(rowIndex: number): void {
  const r = ed.payloadRows[rowIndex];
  if (r) void grid.value?.focusCell(r.uid, 'logicalNm');
}

/** 저장을 막은 "오류 n건" 토스트 — 오류가 없어지거나 저장에 성공하면 닫는다(CR-15 C6, 성공 뒤에도 남던 결함). */
let blockToast: number | null = null;
function clearBlockToast(): void {
  toast.dismiss(blockToast);
  blockToast = null;
}
watch(
  () => ed.errors.length,
  (n) => {
    if (n === 0) clearBlockToast();
  },
);
async function save(overwriteVersion?: number): Promise<void> {
  if (readOnly.value || saving.value) return;
  if (ed.errors.length > 0 && overwriteVersion === undefined) {
    clearBlockToast();
    blockToast = toast.error(`오류 ${ed.errors.length}건을 해결하면 저장할 수 있습니다`);
    focusFirstError();
    return;
  }
  clearBlockToast();
  const body = ed.payload;
  const uids = ed.payloadRows.map((r) => r.uid);
  const sent = ed.payloadJson;
  const oldKey = dKey.value;
  saving.value = true;
  clearTimeout(draftTimer);
  try {
    const r =
      ed.tableId === null
        ? await tapi.create(key.value, body)
        : await tapi.save(key.value, ed.tableId, {
            ...body,
            version: overwriteVersion ?? ed.version!,
          });
    ed.applySaved(r, uids, sent);
    removeDraft(oldKey);
    draftBanner.value = null;
    draftSavedAt.value = null;
    conflict.value = null;
    toast.success(`v${r.version} 저장됨`);
    if (isNew.value) await router.replace(`/projects/${key.value}/tables/${r.tableId}`);
    else if (ed.meta) await reloadDetail();
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.code === 'E_VERSION_CONFLICT' && e.problem) {
      persistDraft();
      conflict.value = { ...(e.problem as unknown as TableConflict), mine: body };
    } else if (e instanceof ApiError && e.status === 409 && e.code === 'E_TABLE_FINAL') {
      persistDraft();
      toast.error('다른 사용자가 확정(FINAL)해 편집할 수 없습니다 — 편집본은 임시저장했습니다');
      await reloadDetail();
    } else if (e instanceof ApiError && e.status === 422) {
      const warns = (e.problem?.['warnings'] as ValidationIssue[] | undefined) ?? [];
      ed.setServerIssues(errIssues(e), warns, uids);
      toast.error(errMsg(e, '검증 오류가 있어 저장하지 않았습니다'));
      focusFirstError();
    } else {
      // 세션 만료(401)·네트워크 오류: 편집 내용을 즉시 임시저장(§8.7) — 재로그인 후 복원 배너
      persistDraft();
      toast.error(`${errMsg(e, '저장하지 못했습니다')} — 편집본은 브라우저에 임시저장했습니다`);
    }
  } finally {
    saving.value = false;
  }
}
function reloadLatest(): void {
  if (!conflict.value) return;
  const c = conflict.value;
  ed.load({ table: c.current.table, columns: c.current.columns }, setCols.value);
  conflict.value = null;
  toast.info(`최신본(v${c.currentVersion})을 불러왔습니다 — 내 편집본은 임시저장에 남아 있습니다`);
  checkDraft();
}
function overwrite(): void {
  if (conflict.value) void save(conflict.value.currentVersion);
}

// ── 임시저장 복원·비교 ─────────────────────────────────────────────
const draftCompareOpen = ref(false);
function restoreDraftNow(): void {
  if (!draftBanner.value) return;
  ed.restoreDraft(draftBanner.value.draft, setCols.value);
  draftBanner.value = null;
  draftCompareOpen.value = false;
  toast.info('임시저장본을 복원했습니다 — 저장하면 서버에 반영됩니다');
}
function discardDraft(): void {
  removeDraft(dKey.value);
  draftBanner.value = null;
  draftCompareOpen.value = false;
}
const draftTime = computed(() =>
  draftBanner.value ? new Date(draftBanner.value.draft.savedAt).toTimeString().slice(0, 5) : '',
);

// ── 상태 전이(§8.4) ─────────────────────────────────────────────────
async function setStatus(status: 'FINAL' | 'DRAFT', close?: () => void): Promise<void> {
  if (ed.tableId === null || ed.version === null) return;
  if (status === 'FINAL' && ed.dirty) {
    toast.error('저장하지 않은 변경이 있습니다 — 먼저 저장하세요');
    return;
  }
  statusBusy.value = true;
  try {
    const r = await tapi.setStatus(key.value, ed.tableId, {
      status,
      version: ed.version,
      note: status === 'DRAFT' ? unfinalizeNote.value.trim() || null : null,
    });
    toast.success(
      status === 'FINAL'
        ? `확정했습니다(v${r.version}) — 편집이 잠깁니다`
        : `확정을 해제했습니다(v${r.version})`,
    );
    unfinalizeNote.value = '';
    close?.();
    await reloadDetail();
  } catch (e) {
    if (e instanceof ApiError && e.status === 422)
      ed.setServerIssues(
        errIssues(e),
        [],
        ed.payloadRows.map((r) => r.uid),
      );
    toast.error(errMsg(e, '상태를 바꾸지 못했습니다'));
  } finally {
    statusBusy.value = false;
  }
}

function onBizChange(e: Event): void {
  const v = Number((e.target as HTMLSelectElement).value);
  const next = bizAreas.value.find((b) => b.bizAreaId === v) ?? null;
  ed.changeBizArea(
    next?.bizAreaId ?? null,
    biz.value?.tablePrefix ?? null,
    next?.tablePrefix ?? null,
  );
  // 물리명 자동 상태면 새 업무구분 접두어로 다시 제안(§5.5 "업무구분을 바꾸면 접두어만 교체")
  if (nmAuto.value) void suggestName();
}
function onCloned(r: TableCloneResponse): void {
  void router.push(`/projects/${r.projectKey}/tables/${r.tableId}`);
}
async function onRestored(): Promise<void> {
  removeDraft(dKey.value);
  await reloadDetail();
}

// ── 단축키(§10.4): Ctrl+S 저장, Ctrl+D DDL 패널 ─────────────────────
function onKey(e: KeyboardEvent): void {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 's') {
    e.preventDefault();
    void save();
  } else if (k === 'd') {
    e.preventDefault();
    toggleDdl();
  }
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  clearTimeout(validateTimer);
  validateCtrl?.abort();
  if (draftTimer) {
    clearTimeout(draftTimer);
    persistDraft();
  }
});

// ── 표시 ───────────────────────────────────────────────────────────
const tableErr = (field: string) =>
  ed.errors.find((i) => i.uid === null && i.field === field) ?? null;
const rowLabel = (uid: string | null) => {
  if (!uid) return '테이블';
  const i = ed.rows.findIndex((r) => r.uid === uid);
  if (i >= 0) return `${i + 1}행`;
  const d = ed.defaultRows.find((r) => r.uid === uid);
  return d ? `기본컬럼 ${d.physicalNm}` : '행';
};
const vOpen = ref(true);
const compareCols = computed(() => ed.payload.columns);
const saveTitle = computed(() =>
  readOnly.value
    ? '읽기 전용'
    : ed.errors.length > 0
      ? `오류 ${ed.errors.length}건을 해결하면 저장할 수 있습니다`
      : '저장 (Ctrl+S)',
);
const restoreBlocked = computed(() =>
  final.value
    ? '확정(FINAL) 테이블은 복원할 수 없습니다'
    : !canEditRole.value || archived.value
      ? '편집 권한이 없습니다'
      : ed.dirty
        ? '저장하지 않은 변경이 있습니다 — 저장하거나 되돌린 뒤 복원하세요'
        : null,
);
const statusLine = computed(() => {
  const m = ed.meta;
  const parts: string[] = [];
  if (m && ed.version !== null)
    parts.push(`v${ed.version} · ${m.updatedByNm ?? m.updatedBy} ${fmtTs(m.updatedAt)} 저장`);
  else parts.push('새 테이블(저장 전)');
  if (ed.dirty) parts.push('저장 안 한 변경 있음');
  if (draftSavedAt.value) parts.push(`브라우저 임시저장 ${draftSavedAt.value}`);
  return parts;
});

// 편집 영역 폭(CR-15 C9): 좁으면(DDL 패널이 열린 1366·1920px 등) 덜 쓰는 단축키 안내를 숨겨 한 줄로,
// 아주 좁으면(좁은 창에서 패널을 연 경우) 그리드 오른쪽 고정 열을 풀어 왼쪽 고정 열과 겹치지 않게
const mainEl = ref<HTMLElement | null>(null);
const narrow = ref(false);
const cramped = ref(false);
let mainWatch: ResizeObserver | null = null;
watch(mainEl, (el) => {
  mainWatch?.disconnect();
  mainWatch = null;
  if (!el || typeof ResizeObserver === 'undefined') return;
  mainWatch = new ResizeObserver(([e]) => {
    if (!e) return;
    narrow.value = e.contentRect.width < 1320;
    cramped.value = e.contentRect.width < 760;
  });
  mainWatch.observe(el);
});
onBeforeUnmount(() => mainWatch?.disconnect());
</script>

<template>
  <EmptyState v-if="notFound" icon="table" title="테이블을 찾을 수 없습니다">
    <RouterLink class="btn btn-secondary" :to="`/projects/${key}/tables`"
      >테이블 목록으로</RouterLink
    >
  </EmptyState>
  <div v-else class="editor" data-testid="table-editor">
    <div ref="mainEl" :class="['editor-main', { 'is-narrow': narrow, 'is-cramped': cramped }]">
      <div class="editor-head">
        <div class="breadcrumb">
          <RouterLink :to="`/projects/${key}`">{{ project?.nm ?? key }}</RouterLink
          ><span>›</span><RouterLink :to="`/projects/${key}/tables`">테이블</RouterLink
          ><template v-if="biz"
            ><span>›</span
            ><RouterLink :to="`/projects/${key}/tables?bizAreaId=${biz.bizAreaId}`"
              >{{ biz.bizCd }} {{ biz.bizNm }}</RouterLink
            ></template
          ><span>›</span><span class="mono">{{ ed.header.tableNm || '새 테이블' }}</span>
        </div>
        <div class="editor-title-row">
          <h1 class="page-title">{{ ed.header.tableLogicalNm || '새 테이블' }}</h1>
          <TfPopover v-if="ed.tableId !== null && !final && canEditRole && !archived">
            <template #trigger="{ toggle, open, menuId }">
              <button
                class="badge badge-draft badge-lg"
                type="button"
                title="상태 변경"
                aria-haspopup="menu"
                :aria-expanded="open"
                :aria-controls="menuId"
                data-testid="status-badge"
                @click="toggle"
              >
                DRAFT <TfIcon name="chevron-down" />
              </button>
            </template>
            <template #default="{ close }">
              <div class="dropdown-label">상태 변경</div>
              <button
                class="dropdown-item"
                type="button"
                role="menuitem"
                :disabled="statusBusy || ed.errors.length > 0"
                @click="setStatus('FINAL', close)"
              >
                <TfBadge kind="final">FINAL</TfBadge>FINAL로 확정 — 편집 잠금
              </button>
            </template>
          </TfPopover>
          <TfBadge v-else :kind="final ? 'final' : 'draft'" lg data-testid="status-badge">{{
            ed.status
          }}</TfBadge>
          <div class="editor-status" data-testid="editor-status" :title="statusLine.join(' · ')">
            <span v-for="(p, i) in statusLine" :key="i">{{ p }}</span>
          </div>
          <div class="editor-actions">
            <TfButton
              v-if="ed.tableId !== null"
              variant="ghost"
              icon="history"
              :class="{ 'is-active': panel === 'history' }"
              @click="setPanel(panel === 'history' ? null : 'history')"
              >이력</TfButton
            >
            <ClonePopover
              v-if="ed.tableId !== null && ed.meta"
              :project-key="key"
              :table-id="ed.tableId"
              :table-nm="ed.meta.tableNm"
              :biz-cd="ed.meta.bizCd"
              @cloned="onCloned"
            />
            <button
              :class="['btn', 'btn-ghost', { 'is-active': panel === 'ddl' }]"
              type="button"
              :aria-expanded="panel === 'ddl'"
              data-testid="toggle-ddl"
              @click="toggleDdl"
            >
              <TfIcon name="panel-right" />DDL <span class="kbd">Ctrl+D</span>
            </button>
            <button
              v-if="!readOnly"
              class="btn btn-primary"
              type="button"
              :disabled="saving || ed.errors.length > 0 || loading"
              :title="saveTitle"
              data-testid="save"
              @click="save()"
            >
              <span v-if="saving" class="spinner" /><TfIcon v-else name="save" />저장
              <span class="kbd">Ctrl+S</span>
            </button>
          </div>
        </div>

        <div v-if="final" class="alert alert-info mb-3" role="status" data-testid="final-banner">
          <TfIcon name="lock" />
          <div class="alert-body">
            <div class="alert-title">
              확정됨(FINAL){{
                ed.meta?.finalizedBy
                  ? ` · ${ed.meta.finalizedBy} ${fmtTs(ed.meta.finalizedAt)}`
                  : ''
              }}
              — 편집이 잠겼습니다
            </div>
            <template v-if="!isAdmin"
              >프로젝트 관리자에게 확정 해제를 요청하세요. DDL 미리보기·복사는 가능합니다.</template
            >
            <div v-else class="row mt-3">
              <input
                v-model="unfinalizeNote"
                class="input input-sm w-320"
                maxlength="500"
                placeholder="해제 사유(선택)"
                aria-label="확정 해제 사유"
              />
              <TfButton
                size="sm"
                variant="secondary"
                icon="unlock"
                :loading="statusBusy"
                @click="setStatus('DRAFT')"
                >확정 해제</TfButton
              >
            </div>
          </div>
        </div>
        <div
          v-else-if="!canEditRole"
          class="alert alert-info mb-3"
          role="status"
          data-testid="readonly-banner"
        >
          <TfIcon name="eye" />
          <div class="alert-body">
            조회자 — 읽기 전용입니다. DDL 미리보기·복사·다운로드는 가능합니다.
          </div>
        </div>
        <div v-else-if="archived" class="alert alert-info mb-3" role="status">
          <TfIcon name="lock" />
          <div class="alert-body">보관된 프로젝트 — 읽기 전용입니다.</div>
        </div>
        <div
          v-if="draftBanner"
          class="alert alert-warning mb-3"
          role="status"
          data-testid="draft-banner"
        >
          <TfIcon name="alert-triangle" />
          <div class="alert-body">
            <div class="alert-title">
              저장되지 않은 편집본({{ draftTime }})이 이 브라우저에 있습니다
            </div>
            <template v-if="draftBanner.newer"
              >그 사이 다른 저장이 있었습니다(v{{ draftBanner.draft.baseVersion }} → v{{
                ed.version
              }}).
            </template>
            임시저장은 이 브라우저에만 있습니다(다른 PC로 이어지지 않음).
            <div class="row mt-3">
              <TfButton size="sm" variant="primary" :disabled="readOnly" @click="restoreDraftNow"
                >복원</TfButton
              >
              <TfButton
                v-if="draftBanner.newer"
                size="sm"
                variant="secondary"
                icon="git-merge"
                @click="draftCompareOpen = true"
                >나란히 비교</TfButton
              >
              <TfButton size="sm" variant="ghost" @click="discardDraft">버리기</TfButton>
            </div>
          </div>
        </div>

        <div class="table-meta">
          <div class="field">
            <label class="field-label" for="ed-biz">업무구분 <span class="req">*</span></label>
            <select
              id="ed-biz"
              :class="['select', { 'is-invalid': tableErr('bizAreaId') }]"
              :value="ed.header.bizAreaId ?? ''"
              :disabled="readOnly"
              @change="onBizChange"
            >
              <option value="" disabled>업무구분 선택</option>
              <option
                v-for="b in bizAreas"
                :key="b.bizAreaId"
                :value="b.bizAreaId"
                :disabled="!b.useYn && b.bizAreaId !== ed.meta?.bizAreaId"
              >
                {{ b.bizCd }} {{ b.bizNm }}{{ b.useYn ? '' : ' (사용 중지)' }}
              </option>
            </select>
            <span class="field-help"
              >접두어 <span class="mono">{{ biz?.tablePrefix ?? '없음' }}</span
              >는 업무구분에서 옵니다 ·
              <RouterLink :to="`/projects/${key}/biz-areas`">업무구분 관리</RouterLink></span
            >
          </div>
          <div class="field">
            <label class="field-label" for="ed-logical"
              >논리 테이블명 <span class="req">*</span></label
            >
            <input
              id="ed-logical"
              v-model="ed.header.tableLogicalNm"
              class="input"
              maxlength="200"
              :readonly="readOnly"
              placeholder="예: 연구과제마스터"
              @change="suggestName"
              @keydown.enter.prevent="suggestName"
            />
          </div>
          <div class="field">
            <label class="field-label" for="ed-phys"
              >물리 테이블명 <span class="req">*</span></label
            >
            <input
              id="ed-phys"
              v-model="ed.header.tableNm"
              :class="['input', 'mono', { 'is-invalid': tableErr('tableNm') }]"
              maxlength="63"
              :readonly="readOnly"
              :title="tableErr('tableNm')?.message"
              spellcheck="false"
              @input="onPhysInput"
              @change="ed.header.tableNm = ed.header.tableNm.trim().toUpperCase()"
            />
            <span v-if="nmAuto && !readOnly" class="field-help"
              >업무구분 접두어 + 용어 분절 자동 제안 · 수정 가능</span
            >
            <SegmentPieces
              v-if="nmAuto && nameSegs.length > 0"
              class="ed-phys-pieces"
              :segments="nameSegs"
            />
          </div>
          <div class="field">
            <label class="field-label" for="ed-desc">설명</label>
            <input
              id="ed-desc"
              v-model="ed.header.description"
              class="input"
              maxlength="4000"
              :readonly="readOnly"
            />
          </div>
        </div>
      </div>

      <div class="editor-body">
        <TfSkeleton v-if="loading" :lines="8" />
        <div v-else-if="loadError" class="alert alert-danger" role="alert">
          <TfIcon name="alert-circle" />
          <div class="alert-body">
            {{ loadError }} <button class="btn-link" type="button" @click="init">다시 시도</button>
          </div>
        </div>
        <template v-else>
          <div
            :class="[
              'validation-bar',
              { 'has-error': ed.errors.length > 0, 'is-collapsed': !vOpen },
            ]"
            data-testid="validation-bar"
          >
            <div class="v-head">
              <span v-if="ed.errors.length > 0" class="v-count error"
                ><TfIcon name="alert-circle" />오류 {{ ed.errors.length }}</span
              >
              <span v-else class="v-count ok"><TfIcon name="check-circle" />오류 없음</span>
              <span class="v-count warn"
                ><TfIcon name="alert-triangle" />경고 {{ ed.warnings.length }}</span
              >
              <span class="text-muted text-sm">{{
                ed.errors.length > 0
                  ? '오류를 해결해야 저장할 수 있습니다. 경고는 저장 가능합니다.'
                  : '경고는 저장 가능합니다.'
              }}</span>
              <span class="spacer" />
              <TfButton
                v-if="!readOnly"
                variant="ghost"
                size="sm"
                icon="refresh"
                @click="validateNow"
                >다시 검증</TfButton
              >
              <button
                class="btn btn-ghost btn-sm"
                type="button"
                :aria-expanded="vOpen"
                @click="vOpen = !vOpen"
              >
                {{ vOpen ? '접기' : '펼치기' }}
              </button>
            </div>
            <ul v-if="ed.issues.length > 0" class="validation-list">
              <li v-for="(i, n) in ed.issues.slice(0, 30)" :key="n">
                <TfBadge :kind="i.severity === 'E' ? 'danger' : 'warning'">{{
                  i.severity === 'E' ? '오류' : '경고'
                }}</TfBadge>
                <span
                  >{{ rowLabel(i.uid) }} {{ i.columnNm ? `${i.columnNm}: ` : ''
                  }}{{ i.message }}</span
                >
                <button class="btn-link v-jump" type="button" @click="focusIssue(i)">
                  {{ rowLabel(i.uid) }}으로 이동
                </button>
              </li>
              <li v-if="ed.issues.length > 30" class="text-muted">
                … {{ ed.issues.length - 30 }}건 더
              </li>
            </ul>
          </div>

          <div class="toolbar">
            <TfButton
              v-if="!readOnly"
              variant="secondary"
              size="sm"
              icon="plus"
              @click="grid?.focusCell(ed.addRow().uid)"
              >행 추가</TfButton
            >
            <span class="spacer" />
            <span class="text-sm text-muted"
              >컬럼 {{ ed.rows.length }} · 기본컬럼
              {{ ed.defaultRows.filter((r) => r.included).length }} 포함</span
            >
          </div>

          <ColumnGrid
            ref="grid"
            :read-only="readOnly"
            :can-register-domain="isAdmin"
            @reapply="reapply"
            @register-domain="registerDomain"
          />
          <DefaultColsArea
            :read-only="readOnly"
            :set-nm="defaultSet?.setNm ?? null"
            :settings-link="`/projects/${key}/settings`"
          />
        </template>
      </div>

      <div class="editor-foot">
        <div class="kbd-bar">
          <span
            ><span class="kbd">Enter</span> 자동완성 → 다음 행<span class="kbd-more"
              >(후보·등록 카드는 Enter 선택·등록)</span
            ></span
          >
          <span><span class="kbd">Tab</span> 다음 셀</span>
          <span class="kbd-more"><span class="kbd">↑</span><span class="kbd">↓</span> 행 이동</span>
          <span class="kbd-more"
            ><span class="kbd">Alt</span>+<span class="kbd">↑</span><span class="kbd">↓</span> 순서
            변경</span
          >
          <span><span class="kbd">Ctrl</span>+<span class="kbd">S</span> 저장</span>
          <span><span class="kbd">Ctrl</span>+<span class="kbd">D</span> DDL 패널</span>
          <span><span class="kbd">Esc</span> 후보·카드 닫기</span>
          <span class="kbd-more"
            ><span class="kbd">Ctrl</span>+<span class="kbd">V</span> 여러 줄 → 일괄 자동완성</span
          >
        </div>
      </div>
    </div>

    <DdlPanel
      v-if="panel === 'ddl' && !loading && !loadError"
      :project-key="key"
      :body="ed.payload"
      :table-id="ed.tableId"
      :saved="!ed.dirty"
      :ready="draftReady"
      :default-dialect="dialect"
      @close="setPanel(null)"
      @focus-row="focusRowIndex"
    />
    <HistoryPanel
      v-else-if="panel === 'history' && ed.tableId !== null && ed.version !== null"
      :project-key="key"
      :table-id="ed.tableId"
      :current-version="ed.version"
      :current="compareCols"
      :current-table="ed.payload.table"
      :can-restore="restoreBlocked === null"
      :restore-blocked="restoreBlocked"
      @close="setPanel(null)"
      @restored="onRestored"
    />
  </div>

  <ConflictMergeModal
    :open="conflict !== null"
    :saved-by="conflict?.savedBy ?? ''"
    :saved-at="fmtTs(conflict?.savedAt)"
    :your-version="conflict?.yourVersion ?? 0"
    :current-version="conflict?.currentVersion ?? 0"
    :change-count="conflictDiff"
    :busy="saving"
    @reload="reloadLatest"
    @overwrite="overwrite"
  >
    <ColumnCompare
      v-if="conflict"
      :left="conflict.current.columns"
      :right="conflict.mine.columns"
      :left-title="`최신본 (서버 v${conflict.currentVersion})`"
      :left-meta="`${conflict.savedBy} · ${fmtTs(conflict.savedAt)}`"
      :right-title="`내 편집본 (v${conflict.yourVersion} 기준)`"
    />
    <div v-if="conflict" class="alert alert-info mt-4">
      <TfIcon name="info" />
      <div class="alert-body">
        <div class="alert-title">권장: 최신본 새로고침 후 내 변경을 다시 적용</div>
        새로고침하면 최신본(v{{ conflict.currentVersion }}) 위에서 편집을 이어갑니다. 덮어쓰기는
        최신본을 이력에 남기고 내 편집본을 v{{ conflict.currentVersion + 1 }}로 저장합니다.
      </div>
    </div>
  </ConflictMergeModal>
  <ConflictMergeModal
    :open="draftCompareOpen && draftBanner !== null"
    :saved-by="ed.meta?.updatedByNm ?? ed.meta?.updatedBy ?? ''"
    :saved-at="fmtTs(ed.meta?.updatedAt)"
    :your-version="draftBanner?.draft.baseVersion ?? 0"
    :current-version="ed.version ?? 0"
    @reload="draftCompareOpen = false"
    @overwrite="restoreDraftNow"
  >
    <ColumnCompare
      v-if="draftBanner"
      :left="ed.payload.columns"
      :right="draftBanner.draft.columns"
      :left-title="`최신본 (서버 v${ed.version})`"
      :right-title="`임시저장본 (v${draftBanner.draft.baseVersion} 기준 · ${draftTime})`"
    />
  </ConflictMergeModal>
</template>
