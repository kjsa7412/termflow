import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import {
  splitStdType,
  typeText,
  type ColumnInput,
  type DefaultColItem,
  type MatchType,
  type StdType,
  type TableColumnItem,
  type TableDetail,
  type TableHeaderItem,
  type TableSaveResponse,
  type TableStatus,
  type ValidationIssue,
} from '@termflow/shared';
import type { EditorDraft } from '../editor/draft-storage.js';

/**
 * 테이블 편집기 스토어(설계서 §10.4, T8.7). 행 상태 머신 + dirty 추적 + 서버 응답 병합.
 *
 * 행 상태(§10.4 표) — 단계 8은 idle·manual·invalid·default, 로드된 컬럼은 match_type으로 표시 상태를 정한다.
 * 자동완성 상태(loading·exact·similar·composed·unregistered·code)의 **전이**는 T9.7에서 `onLogicalEnter` 훅에 붙는다.
 *
 * | 상태 | 진입 | 다음 |
 * |---|---|---|
 * | idle | 새 행 | 물리명·타입 입력 → manual (논리명만 입력하면 idle 유지 — T9: Enter → loading) |
 * | manual | 물리명·타입 직접 수정(어느 상태에서든, 기본컬럼 제외) | — |
 * | default | 기본컬럼 영역 행(defaultColId) | 포함/제외만(편집 불가) |
 * | invalid | (파생) 행에 E가 있음 | E 해소 → 원래 상태 |
 *
 * 저장 본문 순서 = 일반 행(표시 순서) → 포함된 기본컬럼(세트 순서)(§8.2 "기본컬럼 영역은 뒤").
 */
export type RowState =
  | 'idle'
  | 'manual'
  | 'default'
  | 'loading'
  | 'exact'
  | 'similar'
  | 'composed'
  | 'unregistered'
  | 'code';

export type CellField =
  | 'logicalNm'
  | 'physicalNm'
  | 'typeText'
  | 'defaultVal'
  | 'colComment'
  | 'isPk'
  | 'isNullable';

export interface EditorRow {
  uid: string;
  columnId: number | null;
  logicalNm: string;
  physicalNm: string;
  /** 타입 셀 원문(`VARCHAR(20)`). 파싱 결과가 dataType·dataLength·dataScale. */
  typeText: string;
  dataType: StdType | null;
  dataLength: number | null;
  dataScale: number | null;
  /** 타입 셀 파싱 실패 사유(형식·알 수 없는 타입) — 로컬 오류. */
  typeError: string | null;
  isPk: boolean;
  isNullable: boolean;
  defaultVal: string;
  colComment: string;
  domainId: number | null;
  codeClsId: number | null;
  defaultColId: number | null;
  matchType: MatchType;
  state: RowState;
  /** 표시용(코드 칩·도메인 툴팁). */
  codeCls: TableColumnItem['codeCls'];
  domainNm: string | null;
  /** 기본컬럼 영역 행만 의미: 제외(false)면 저장 본문에서 빠진다(= 행 삭제, §8.2). */
  included: boolean;
}

export interface EditorHeader {
  bizAreaId: number | null;
  tableNm: string;
  tableLogicalNm: string;
  description: string;
}

/** 오류·경고 1건 + 대상 행(uid, 없으면 테이블). */
export interface RowIssue extends ValidationIssue {
  uid: string | null;
  severity: 'E' | 'W';
}

let seq = 0;
const newUid = () => `r${++seq}`;

/** match_type → 초기 표시 상태(로드 시). */
export function stateOf(matchType: MatchType, defaultColId: number | null): RowState {
  if (defaultColId !== null) return 'default';
  switch (matchType) {
    case 'EXACT':
    case 'SIMILAR':
      return 'exact';
    case 'COMPOSED':
      return 'composed';
    case 'UNREGISTERED':
      return 'unregistered';
    case 'CODE':
      return 'code';
    case 'DEFAULT':
      return 'default';
    default:
      return 'manual';
  }
}

function blankRow(): EditorRow {
  return {
    uid: newUid(),
    columnId: null,
    logicalNm: '',
    physicalNm: '',
    typeText: '',
    dataType: null,
    dataLength: null,
    dataScale: null,
    typeError: null,
    isPk: false,
    isNullable: true,
    defaultVal: '',
    colComment: '',
    domainId: null,
    codeClsId: null,
    defaultColId: null,
    matchType: 'MANUAL',
    state: 'idle',
    codeCls: null,
    domainNm: null,
    included: true,
  };
}

type ColumnLike = Omit<ColumnInput, 'columnId'> & {
  columnId: number | null;
  codeCls?: TableColumnItem['codeCls'];
  domainNm?: string | null;
};

export function rowFrom(c: ColumnLike): EditorRow {
  return {
    ...blankRow(),
    columnId: c.columnId,
    logicalNm: c.logicalNm,
    physicalNm: c.physicalNm,
    typeText: typeText(c.dataType, c.dataLength, c.dataScale) ?? '',
    dataType: c.dataType,
    dataLength: c.dataLength,
    dataScale: c.dataScale,
    isPk: c.isPk,
    isNullable: c.isPk ? false : c.isNullable,
    defaultVal: c.defaultVal ?? '',
    colComment: c.colComment ?? '',
    domainId: c.domainId,
    codeClsId: c.codeClsId,
    defaultColId: c.defaultColId,
    matchType: c.matchType,
    state: stateOf(c.matchType, c.defaultColId),
    codeCls: c.codeCls ?? null,
    domainNm: c.domainNm ?? null,
  };
}

function defaultRowFrom(d: DefaultColItem, included: boolean): EditorRow {
  return {
    ...rowFrom({
      columnId: null,
      logicalNm: d.logicalNm,
      physicalNm: d.physicalNm,
      isPk: d.isPk,
      dataType: d.dataType,
      dataLength: d.dataLength,
      dataScale: d.dataScale,
      isNullable: d.isNullable,
      defaultVal: d.defaultVal,
      colComment: d.colComment ?? d.logicalNm,
      domainId: null,
      codeClsId: null,
      defaultColId: d.defaultColId,
      matchType: 'DEFAULT',
    }),
    included,
  };
}

const nul = (s: string) => (s.trim() === '' ? null : s.trim());

/** 저장 본문 1행. 빈 새 행(논리명·물리명·타입 모두 빈 값)은 보내지 않는다(편집기 "입력 대기" 행). */
export function toColumnInput(r: EditorRow): ColumnInput {
  return {
    columnId: r.columnId,
    logicalNm: r.logicalNm.trim(),
    physicalNm: r.physicalNm.trim().toUpperCase(),
    isPk: r.isPk,
    dataType: r.dataType,
    dataLength: r.dataLength,
    dataScale: r.dataScale,
    isNullable: r.isPk ? false : r.isNullable,
    defaultVal: nul(r.defaultVal),
    colComment: nul(r.colComment),
    domainId: r.domainId,
    codeClsId: r.codeClsId,
    defaultColId: r.defaultColId,
    matchType: r.matchType,
  };
}
export const isBlankRow = (r: EditorRow) =>
  r.columnId === null &&
  r.logicalNm.trim() === '' &&
  r.physicalNm.trim() === '' &&
  r.typeText.trim() === '';

/** 타입 셀 원문 → 3분할(StdTypeParser 공유, §6.3). 길이 규칙(E_TYPE_LEN_*)은 서버 검증이 판정. */
export function parseTypeCell(text: string): Pick<
  EditorRow,
  'dataType' | 'dataLength' | 'dataScale' | 'typeError'
> {
  const r = splitStdType(text);
  if (r.ok) return { dataType: r.type, dataLength: r.length, dataScale: r.scale, typeError: null };
  if (r.reason === 'EMPTY') return { dataType: null, dataLength: null, dataScale: null, typeError: null };
  return {
    dataType: null,
    dataLength: null,
    dataScale: null,
    typeError:
      r.reason === 'UNKNOWN_TYPE'
        ? `알 수 없는 타입입니다: ${text.trim()} (표준 타입 12종)`
        : `타입 형식 오류: ${text.trim()} (예: VARCHAR(20), NUMERIC(7,4))`,
  };
}

/** 스토어 본체(Pinia 없이도 쓰는 순수 반응형 — 상태 머신 단위 테스트, T8.7 DoD). */
export function createEditorCore() {
  const projectKey = ref('');
  const tableId = ref<number | null>(null);
  const version = ref<number | null>(null);
  const status = ref<TableStatus>('DRAFT');
  const meta = ref<TableHeaderItem | null>(null);
  const header = reactive<EditorHeader>({
    bizAreaId: null,
    tableNm: '',
    tableLogicalNm: '',
    description: '',
  });
  const rows = ref<EditorRow[]>([]);
  const defaultRows = ref<EditorRow[]>([]);
  /** 서버 검증 결과(POST validate·저장 422)와 그때 본문 행 순서(rowIndex → uid). */
  const serverErrors = ref<ValidationIssue[]>([]);
  const serverWarnings = ref<ValidationIssue[]>([]);
  const issueUids = ref<string[]>([]);
  /** 마지막 로드·저장 시점의 본문(JSON) — dirty 판정 기준. */
  const baseline = ref('');

  const payloadRows = computed(() => [
    ...rows.value.filter((r) => !isBlankRow(r)),
    ...defaultRows.value.filter((r) => r.included),
  ]);
  const payload = computed(() => ({
    table: {
      bizAreaId: header.bizAreaId,
      tableNm: header.tableNm.trim().toUpperCase(),
      tableLogicalNm: header.tableLogicalNm.trim(),
      description: nul(header.description),
    },
    columns: payloadRows.value.map(toColumnInput),
  }));
  const payloadJson = computed(() => JSON.stringify(payload.value));
  const dirty = computed(() => payloadJson.value !== baseline.value);

  // ── 이슈 ────────────────────────────────────────────────────────
  const localErrors = computed<RowIssue[]>(() =>
    [...rows.value, ...defaultRows.value]
      .filter((r) => r.typeError !== null && (r.included || r.defaultColId === null))
      .map((r) => ({
        code: 'E_TYPE_FORMAT',
        target: 'column',
        field: 'dataType',
        message: r.typeError!,
        uid: r.uid,
        severity: 'E',
        ...(r.physicalNm ? { columnNm: r.physicalNm } : {}),
      })),
  );
  const mapIssue = (i: ValidationIssue, severity: 'E' | 'W'): RowIssue => ({
    ...i,
    severity,
    uid: i.target === 'column' && i.rowIndex !== undefined ? (issueUids.value[i.rowIndex] ?? null) : null,
  });
  const issues = computed<RowIssue[]>(() => {
    const local = localErrors.value;
    const localUids = new Set(local.map((l) => l.uid));
    const known = new Set([...rows.value, ...defaultRows.value].map((r) => r.uid));
    const server = [
      ...serverErrors.value.map((e) => mapIssue(e, 'E')),
      ...serverWarnings.value.map((w) => mapIssue(w, 'W')),
    ].filter(
      (i) =>
        (i.uid === null || known.has(i.uid)) &&
        // 타입 셀 파싱 오류가 있으면 서버의 E_TYPE_MISSING(같은 셀)은 겹쳐 보이지 않게
        !(i.uid !== null && localUids.has(i.uid) && i.code === 'E_TYPE_MISSING'),
    );
    return [...local, ...server];
  });
  const errors = computed(() => issues.value.filter((i) => i.severity === 'E'));
  const warnings = computed(() => issues.value.filter((i) => i.severity === 'W'));
  const issuesOf = (uid: string) => issues.value.filter((i) => i.uid === uid);
  const fieldError = (uid: string, field: string) =>
    errors.value.find(
      (i) =>
        i.uid === uid &&
        (i.field === field || (field === 'typeText' && (i.field === 'dataType' || i.field === 'dataLength'))),
    ) ?? null;
  /** 표시 상태: E가 있으면 invalid(파생), 아니면 행 상태. */
  const displayState = (r: EditorRow): RowState | 'invalid' =>
    errors.value.some((e) => e.uid === r.uid) ? 'invalid' : r.state;

  function setServerIssues(
    errs: ValidationIssue[],
    warns: ValidationIssue[],
    uids: string[] = payloadRows.value.map((r) => r.uid),
  ): void {
    serverErrors.value = errs;
    serverWarnings.value = warns;
    issueUids.value = uids;
  }
  function clearServerIssues(): void {
    setServerIssues([], [], []);
  }

  // ── 로드 ────────────────────────────────────────────────────────
  function reset(key: string): void {
    projectKey.value = key;
    tableId.value = null;
    version.value = null;
    status.value = 'DRAFT';
    meta.value = null;
    Object.assign(header, { bizAreaId: null, tableNm: '', tableLogicalNm: '', description: '' });
    rows.value = [];
    defaultRows.value = [];
    clearServerIssues();
    baseline.value = '';
  }

  /** 기본 세트 중 컬럼에 없는 것 → 제외 상태로 영역에 둔다(다시 포함 가능). */
  function withMissingDefaults(present: EditorRow[], set: readonly DefaultColItem[]): EditorRow[] {
    const have = new Set(present.map((r) => r.defaultColId));
    const byId = new Map(set.map((d, i) => [d.defaultColId, i]));
    const merged = [
      ...present,
      ...set.filter((d) => !have.has(d.defaultColId)).map((d) => defaultRowFrom(d, false)),
    ];
    // 세트 순서(세트에 없는 기본컬럼은 뒤)
    return merged.sort(
      (a, b) =>
        (byId.get(a.defaultColId ?? -1) ?? 1e6) - (byId.get(b.defaultColId ?? -1) ?? 1e6),
    );
  }

  function applyColumns(columns: readonly ColumnLike[], defaultSet: readonly DefaultColItem[]) {
    const all = columns.map(rowFrom);
    rows.value = all.filter((r) => r.defaultColId === null);
    defaultRows.value = withMissingDefaults(
      all.filter((r) => r.defaultColId !== null),
      defaultSet,
    );
    if (rows.value.length === 0) rows.value = [blankRow()];
  }

  /** GET P/tables/{id} 결과로 교체(최신본 새로고침도 같은 경로). */
  function load(d: Pick<TableDetail, 'table' | 'columns'> & Partial<TableDetail>, defaultSet: readonly DefaultColItem[] = []): void {
    projectKey.value = d.table.projectKey;
    tableId.value = d.table.tableId;
    version.value = d.table.version;
    status.value = d.table.status;
    meta.value = d.table;
    Object.assign(header, {
      bizAreaId: d.table.bizAreaId,
      tableNm: d.table.tableNm,
      tableLogicalNm: d.table.tableLogicalNm,
      description: d.table.description ?? '',
    });
    applyColumns(d.columns, defaultSet);
    setServerIssues(d.errors ?? [], d.warnings ?? []);
    baseline.value = payloadJson.value;
  }

  /** 새 테이블(§10.5 "빈 행 1개 + 기본컬럼 영역"): 업무구분 접두어로 물리명 시작, 기본 세트 9행 선삽입(§8.2). */
  function initNew(
    key: string,
    opts: { bizAreaId: number | null; prefix: string | null; defaultSet: readonly DefaultColItem[] },
  ): void {
    reset(key);
    header.bizAreaId = opts.bizAreaId;
    header.tableNm = opts.prefix ?? '';
    rows.value = [blankRow()];
    defaultRows.value = opts.defaultSet.map((d) => defaultRowFrom(d, true));
    baseline.value = payloadJson.value;
  }

  /** 임시저장본 복원(§8.7). baseVersion은 그대로 두고(서버 version 기준으로 저장) 본문만 교체한다. */
  function restoreDraft(draft: EditorDraft, defaultSet: readonly DefaultColItem[]): void {
    Object.assign(header, { ...draft.table, description: draft.table.description ?? '' });
    applyColumns(draft.columns, defaultSet);
    clearServerIssues();
  }

  // ── 편집(상태 전이) ─────────────────────────────────────────────
  const find = (uid: string) =>
    rows.value.find((r) => r.uid === uid) ?? defaultRows.value.find((r) => r.uid === uid) ?? null;

  function setCell(uid: string, field: CellField, value: string | boolean): void {
    const r = find(uid);
    if (!r) return;
    if (r.defaultColId !== null && field !== 'isNullable' && field !== 'colComment') return; // 기본컬럼은 포함/제외만
    switch (field) {
      case 'isPk':
        r.isPk = value === true;
        if (r.isPk) r.isNullable = false; // PK 체크 시 NOT NULL 자동(T8.8)
        return;
      case 'isNullable':
        if (!r.isPk) r.isNullable = value === true;
        return;
      case 'typeText': {
        r.typeText = String(value);
        Object.assign(r, parseTypeCell(r.typeText));
        break;
      }
      default:
        r[field] = String(value);
    }
    // 물리명·타입을 직접 고치면 manual(배지 제거, 회색 '수동', §10.4). 논리명·코멘트·기본값은 상태를 바꾸지 않는다.
    if (field === 'physicalNm' || field === 'typeText') {
      if (r.defaultColId === null) {
        r.state = 'manual';
        r.matchType = 'MANUAL';
      }
    }
  }

  function addRow(afterUid?: string): EditorRow {
    const row = blankRow();
    const i = afterUid ? rows.value.findIndex((r) => r.uid === afterUid) : -1;
    if (i < 0) rows.value.push(row);
    else rows.value.splice(i + 1, 0, row);
    return row;
  }
  function insertAbove(uid: string): EditorRow {
    const row = blankRow();
    const i = rows.value.findIndex((r) => r.uid === uid);
    rows.value.splice(Math.max(0, i), 0, row);
    return row;
  }
  function duplicateRow(uid: string): EditorRow | null {
    const i = rows.value.findIndex((r) => r.uid === uid);
    if (i < 0) return null;
    const src = rows.value[i]!;
    const row: EditorRow = { ...src, uid: newUid(), columnId: null, physicalNm: `${src.physicalNm}`, state: 'manual', matchType: 'MANUAL' };
    rows.value.splice(i + 1, 0, row);
    return row;
  }
  function removeRow(uid: string): void {
    rows.value = rows.value.filter((r) => r.uid !== uid);
    if (rows.value.length === 0) rows.value = [blankRow()];
  }
  /** Alt+↑/↓(드래그 대안, §10.4). 끝에서는 움직이지 않는다. */
  function moveRow(uid: string, delta: -1 | 1): boolean {
    const i = rows.value.findIndex((r) => r.uid === uid);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= rows.value.length) return false;
    const next = [...rows.value];
    [next[i], next[j]] = [next[j]!, next[i]!];
    rows.value = next;
    return true;
  }
  /** 드래그 순서 변경: from 행을 to 위치로. */
  function moveRowTo(fromUid: string, toUid: string): void {
    const from = rows.value.findIndex((r) => r.uid === fromUid);
    const to = rows.value.findIndex((r) => r.uid === toUid);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...rows.value];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x!);
    rows.value = next;
  }
  function toggleDefault(uid: string, included?: boolean): void {
    const r = defaultRows.value.find((x) => x.uid === uid);
    if (r) r.included = included ?? !r.included;
  }
  /** 업무구분 변경(§8.4): 물리명이 이전 업무구분 접두어로 시작하면 새 접두어로 바꾼다(§5.5 "접두어만 교체"). */
  function changeBizArea(bizAreaId: number | null, oldPrefix: string | null, newPrefix: string | null): void {
    header.bizAreaId = bizAreaId;
    const nm = header.tableNm;
    if (oldPrefix && nm.toUpperCase().startsWith(oldPrefix.toUpperCase())) {
      header.tableNm = `${newPrefix ?? ''}${nm.slice(oldPrefix.length)}`;
    } else if (!oldPrefix && newPrefix && nm.trim() === '') {
      header.tableNm = newPrefix;
    }
  }

  /**
   * 논리명 셀 Enter(§10.4 표 "Enter(논리명) → 자동완성 → 다음 행/새 행"). 단계 8은 자동완성 없이 다음 행으로만 이동한다.
   * T9.7: 여기서 `autocomplete`(설정 시)를 호출해 loading → exact/similar/composed/unregistered/code로 전이한다.
   */
  const autocomplete = ref<((row: EditorRow) => Promise<void>) | null>(null);
  async function onLogicalEnter(uid: string): Promise<EditorRow> {
    const r = find(uid);
    if (r && autocomplete.value && r.logicalNm.trim() !== '') await autocomplete.value(r);
    const i = rows.value.findIndex((x) => x.uid === uid);
    if (i >= 0 && i === rows.value.length - 1) return addRow(uid);
    return rows.value[i + 1] ?? addRow();
  }

  // ── 저장 응답 병합 ──────────────────────────────────────────────
  /**
   * 저장 성공(201/200): 본문 순서대로 새 columnId를 행에 붙이고(두 번째 저장부터 update 경로, §8.2) version·status 갱신,
   * 서버 경고를 이슈로, 현재 본문을 dirty 기준으로. `sentUids` = 요청을 보낼 때의 행 순서.
   */
  function applySaved(r: TableSaveResponse, sentUids: string[], sentJson: string): void {
    r.columns.forEach((c, i) => {
      const row = find(sentUids[i] ?? '');
      if (row) row.columnId = c.columnId;
    });
    tableId.value = r.tableId;
    version.value = r.version;
    status.value = r.status;
    setServerIssues([], r.warnings, sentUids);
    // 저장 중에 편집이 계속됐으면 그만큼은 dirty로 남는다
    baseline.value = sentJson === payloadJson.value ? payloadJson.value : sentJsonWithIds(sentJson, r);
  }
  function sentJsonWithIds(sentJson: string, r: TableSaveResponse): string {
    try {
      const p = JSON.parse(sentJson) as { table: unknown; columns: ColumnInput[] };
      p.columns = p.columns.map((c, i) => ({ ...c, columnId: r.columns[i]?.columnId ?? c.columnId }));
      return JSON.stringify(p);
    } catch {
      return sentJson;
    }
  }

  function markStatus(s: TableStatus, v: number): void {
    status.value = s;
    version.value = v;
  }

  return {
    projectKey,
    tableId,
    version,
    status,
    meta,
    header,
    rows,
    defaultRows,
    payload,
    payloadRows,
    payloadJson,
    dirty,
    issues,
    errors,
    warnings,
    issuesOf,
    fieldError,
    displayState,
    setServerIssues,
    clearServerIssues,
    reset,
    load,
    initNew,
    restoreDraft,
    setCell,
    addRow,
    insertAbove,
    duplicateRow,
    removeRow,
    moveRow,
    moveRowTo,
    toggleDefault,
    changeBizArea,
    autocomplete,
    onLogicalEnter,
    applySaved,
    markStatus,
    find,
  };
}

export type EditorCore = ReturnType<typeof createEditorCore>;

/** 편집기 화면 스토어(한 번에 테이블 1개). */
export const useEditorStore = defineStore('editor', () => createEditorCore());
