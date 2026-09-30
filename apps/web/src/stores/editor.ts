import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import {
  normalizeLogical,
  splitStdType,
  typeText,
  type AutocompleteApplied,
  type AutocompleteCandidate,
  type AutocompleteCodeCandidate,
  type AutocompleteResponse,
  type AutocompleteSegment,
  type AutocompleteType,
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
 * 테이블 편집기 스토어(설계서 §10.4, T8.7·T9.7). 행 상태 머신 + dirty 추적 + 서버 응답 병합 + 자동완성 전이.
 *
 * | 상태 | 진입 | 표시 | 다음 |
 * |---|---|---|---|
 * | idle | 새 행 | 빈 논리명 | 논리명 Enter → loading |
 * | loading | 논리명 Enter(자동완성 필요 시) | 행 우측 스피너 | 응답 → 아래 상태 / 실패 → 이전 상태 + 안내 |
 * | exact | type=exact 또는 유사 후보에서 도메인 선택(SIMILAR) | 채움, 초록 '표준' | 다음 행 |
 * | similar | type=similar | 인라인 listbox(도메인 ≤5 + 조합) | ↑↓ Enter 선택 → exact/composed · Esc 닫고 유지 |
 * | composed | type=composed 또는 조합 선택 | 채움 + 조각 배지, 노란 '표준 도메인 아님' | 다음 행 |
 * | unregistered | type=unregistered | 부분 물리명(`?`) + 미매칭 빨간 조각 + 인라인 등록 카드 | 등록 → 자동 재시도 · Esc 카드 닫고 수동 입력(경고 유지) |
 * | code | 코드성 후보 선택 또는 행 '코드' 팝오버 | 파랑 배지 | 다음 행 |
 * | manual | 물리명·타입 직접 수정(기본컬럼·미등록 제외) | 회색 '수동' | — |
 * | default | 기본컬럼 영역 행 | 포함/제외만 | — |
 * | invalid | (파생) 행에 E가 있음 | 빨간 테두리 | E 해소 → 원래 상태 |
 *
 * 자동완성 호출은 화면이 `autocomplete`(행 1개)·`batchAutocomplete`(붙여넣기)·`registerTerm`(인라인 등록) 훅으로 연결한다.
 * 같은 논리명(정규화 기준 `acFor`)으로 이미 처리한 행은 Enter로 다시 호출하지 않는다(수동 수정 보호).
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
  'logicalNm' | 'physicalNm' | 'typeText' | 'defaultVal' | 'colComment' | 'isPk' | 'isNullable';

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
  /** 마지막으로 자동완성(또는 로드)한 논리명(정규화). 같으면 Enter로 다시 부르지 않는다. */
  acFor: string | null;
  /** 코멘트를 자동완성이 채웠는지(사용자가 고치면 false — 이후 자동완성이 덮어쓰지 않는다). */
  commentAuto: boolean;
  /** 자동완성 결과·열린 보조 UI(listbox·등록 카드). 저장 본문에는 들어가지 않는다. */
  ac: RowAc | null;
  /** 자동완성 호출 실패 안내(네트워크 등). */
  acError: string | null;
  /** loading 진입 전 상태(실패 시 복귀). */
  prevState: RowState | null;
}

/** 인라인 등록 카드 입력(§10.4 unregistered, §5.9). */
export interface RegisterDraft {
  kor: string;
  physical: string;
  description: string;
  busy: boolean;
  error: string | null;
}

export interface RowAc {
  type: AutocompleteType;
  segments: AutocompleteSegment[];
  candidates: AutocompleteCandidate[];
  codeCandidates: AutocompleteCodeCandidate[];
  alternatives: { physicalNm: string; segments: AutocompleteSegment[] }[];
  registerCandidates: string[];
  warnings: ValidationIssue[];
  /** list = 유사·코드 후보 listbox, register = 인라인 등록 카드. */
  open: 'list' | 'register' | null;
  focus: number;
  /** Esc로 닫았으면 같은 논리명 Enter에 다시 열지 않는다(다음 행으로 이동). */
  dismissed: boolean;
  reg: RegisterDraft;
}

/** listbox 항목(코드성 후보가 먼저, 이어서 유사 도메인·조합 — 목업 08 코드 후보 순서). */
export type AcItem =
  | { kind: 'code'; code: AutocompleteCodeCandidate }
  | { kind: 'domain' | 'composed'; cand: AutocompleteCandidate };

export function acItems(ac: RowAc | null): AcItem[] {
  if (!ac) return [];
  return [
    ...ac.codeCandidates.map((code) => ({ kind: 'code' as const, code })),
    ...ac.candidates.map((cand) => ({ kind: cand.kind, cand })),
  ];
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
    acFor: null,
    commentAuto: false,
    ac: null,
    acError: null,
    prevState: null,
  };
}

/** 자동완성을 불러야 하는 행: 일반 행 · 논리명 있음 · 수동 수정 아님 · 마지막 처리한 논리명과 다름. */
export function needsAutocomplete(r: EditorRow): boolean {
  if (r.defaultColId !== null || r.state === 'manual' || r.state === 'loading') return false;
  const s = normalizeLogical(r.logicalNm);
  return s !== '' && s !== r.acFor;
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
    // 로드한 행은 이미 처리된 것으로 본다(Enter로 이동할 때 저장값을 덮어쓰지 않게)
    acFor: normalizeLogical(c.logicalNm),
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
export function parseTypeCell(
  text: string,
): Pick<EditorRow, 'dataType' | 'dataLength' | 'dataScale' | 'typeError'> {
  const r = splitStdType(text);
  if (r.ok) return { dataType: r.type, dataLength: r.length, dataScale: r.scale, typeError: null };
  if (r.reason === 'EMPTY')
    return { dataType: null, dataLength: null, dataScale: null, typeError: null };
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
    uid:
      i.target === 'column' && i.rowIndex !== undefined
        ? (issueUids.value[i.rowIndex] ?? null)
        : null,
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
        (i.field === field ||
          (field === 'typeText' && (i.field === 'dataType' || i.field === 'dataLength'))),
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
      (a, b) => (byId.get(a.defaultColId ?? -1) ?? 1e6) - (byId.get(b.defaultColId ?? -1) ?? 1e6),
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
  function load(
    d: Pick<TableDetail, 'table' | 'columns'> & Partial<TableDetail>,
    defaultSet: readonly DefaultColItem[] = [],
  ): void {
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
    opts: {
      bizAreaId: number | null;
      prefix: string | null;
      defaultSet: readonly DefaultColItem[];
    },
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
    if (field === 'colComment') r.commentAuto = false;
    // 물리명·타입을 직접 고치면 manual(배지 제거, 회색 '수동', §10.4). 논리명·코멘트·기본값은 상태를 바꾸지 않는다.
    // 미등록 행은 수동 입력을 허용하되 미등록 상태(W_TERM_UNREGISTERED)를 유지한다(§10.4 "Esc → 수동 입력 허용").
    if (field === 'physicalNm' || field === 'typeText') {
      if (r.defaultColId === null && r.state !== 'unregistered') {
        r.state = 'manual';
        r.matchType = 'MANUAL';
        if (r.ac) r.ac.open = null;
      }
    }
  }

  // ── 자동완성 전이(T9.7) ─────────────────────────────────────────
  type Fillable = Pick<
    AutocompleteApplied,
    'physicalNm' | 'dataType' | 'dataLength' | 'dataScale' | 'typeText' | 'colComment'
  > & { domainId?: number | null };
  function fill(r: EditorRow, a: Fillable, matchType: MatchType) {
    r.physicalNm = a.physicalNm;
    r.dataType = a.dataType;
    r.dataLength = a.dataLength;
    r.dataScale = a.dataScale;
    r.typeText = a.typeText ?? typeText(a.dataType, a.dataLength, a.dataScale) ?? '';
    r.typeError = null;
    r.domainId = a.domainId ?? null;
    r.codeClsId = null;
    r.codeCls = null;
    r.matchType = matchType;
    r.domainNm = matchType === 'EXACT' || matchType === 'SIMILAR' ? a.colComment : null;
    if (r.colComment.trim() === '' || r.commentAuto) {
      r.colComment = a.colComment;
      r.commentAuto = true;
    }
  }

  function beginLoading(uid: string): void {
    const r = find(uid);
    if (!r || r.state === 'loading') return;
    r.prevState = r.state;
    r.state = 'loading';
    r.acError = null;
  }
  /** 호출 실패·취소: 이전 상태로(편집 내용 유지). */
  function endLoading(uid: string, error: string | null = null): void {
    const r = find(uid);
    if (!r) return;
    if (r.state === 'loading') r.state = r.prevState ?? 'idle';
    r.prevState = null;
    r.acError = error;
  }

  /**
   * 응답 적용(§10.4 표). `batch`(붙여넣기 일괄)면 listbox·카드를 열지 않는다 — 그 행에서 Enter하면 연다.
   * 반환: 보조 UI가 열렸으면 'stay'(포커스를 행에 둔다), 아니면 'next'.
   */
  function applyAutocomplete(
    uid: string,
    res: AutocompleteResponse,
    opts: { batch?: boolean } = {},
  ): 'stay' | 'next' {
    const r = find(uid);
    if (!r) return 'next';
    r.prevState = null;
    r.acError = null;
    r.acFor = res.normalized;
    const firstMiss = res.segments?.find((x) => !x.matched)?.kor ?? '';
    const ac: RowAc = {
      type: res.type,
      segments: res.segments ?? [],
      candidates: res.candidates ?? [],
      codeCandidates: res.codeCandidates ?? [],
      alternatives: res.alternatives ?? [],
      registerCandidates: res.registerCandidates ?? [],
      warnings: res.warnings,
      open: null,
      focus: 0,
      dismissed: false,
      reg: {
        kor: res.registerCandidates?.[0] ?? firstMiss,
        physical: '',
        description: '',
        busy: false,
        error: null,
      },
    };
    switch (res.type) {
      case 'exact':
        fill(r, res.applied!, 'EXACT');
        r.state = 'exact';
        break;
      case 'composed':
        fill(r, res.applied!, 'COMPOSED');
        r.state = 'composed';
        break;
      case 'similar':
        r.state = 'similar';
        ac.open = 'list';
        break;
      case 'unregistered':
        fill(r, res.applied!, 'UNREGISTERED');
        r.domainNm = null;
        r.state = 'unregistered';
        ac.open = 'register';
        break;
    }
    if (ac.codeCandidates.length > 0 && ac.open === null) ac.open = 'list';
    if (opts.batch) ac.open = null;
    r.ac = ac;
    return ac.open ? 'stay' : 'next';
  }

  function acMove(uid: string, delta: number): void {
    const r = find(uid);
    const n = acItems(r?.ac ?? null).length;
    if (!r?.ac || n === 0) return;
    r.ac.focus = (r.ac.focus + delta + n) % n;
  }

  function acSetFocus(uid: string, index: number): void {
    const r = find(uid);
    if (r?.ac && index >= 0 && index < acItems(r.ac).length) r.ac.focus = index;
  }

  /** listbox 항목 선택(Enter·클릭). 코드 → code, 도메인 → exact(SIMILAR 기록), 조합 → composed. */
  function acChoose(uid: string, index?: number): boolean {
    const r = find(uid);
    const ac = r?.ac;
    const item = acItems(ac ?? null)[index ?? ac?.focus ?? 0];
    if (!r || !ac || !item) return false;
    if (item.kind === 'code') {
      const c = item.code;
      r.logicalNm = c.logicalNm;
      fill(r, c, 'CODE');
      r.domainNm = null;
      r.codeClsId = c.codeClsId;
      r.codeCls = {
        codeClsId: c.codeClsId,
        bizCd: c.bizCd,
        codeCls: c.codeCls,
        codeClsNm: c.codeClsNm,
      };
      r.state = 'code';
    } else if (item.kind === 'domain') {
      r.logicalNm = item.cand.logicalNm;
      fill(r, item.cand, 'SIMILAR');
      r.state = 'exact';
    } else {
      fill(r, item.cand, 'COMPOSED');
      r.state = 'composed';
      ac.segments = item.cand.segments ?? ac.segments;
    }
    r.acFor = normalizeLogical(r.logicalNm);
    ac.open = null;
    return true;
  }

  /** Esc: listbox·카드 닫기(행 상태 유지, 같은 논리명 Enter에 다시 열지 않음). */
  function acClose(uid: string): void {
    const r = find(uid);
    if (!r?.ac) return;
    r.ac.open = null;
    r.ac.dismissed = true;
  }
  /** 이미 받은 결과의 보조 UI를 다시 연다(붙여넣기 일괄 결과·닫지 않은 행). 열었으면 true. */
  function acReopen(uid: string): boolean {
    const r = find(uid);
    const ac = r?.ac;
    if (!r || !ac || ac.dismissed || ac.open) return false;
    if (r.state === 'unregistered') ac.open = 'register';
    else if (acItems(ac).length > 0 && (r.state === 'similar' || ac.codeCandidates.length > 0))
      ac.open = 'list';
    return ac.open !== null;
  }
  function setReg(uid: string, field: 'kor' | 'physical' | 'description', value: string): void {
    const r = find(uid);
    if (r?.ac) r.ac.reg[field] = value;
  }

  /** 행 '코드' 팝오버(§5.6): 코드구분 연결/해제. 연결하면 code 상태·match_type CODE, 코멘트가 비었으면 채운다. */
  function setCodeCls(uid: string, c: NonNullable<TableColumnItem['codeCls']> | null): void {
    const r = find(uid);
    if (!r || r.defaultColId !== null) return;
    if (c === null) {
      r.codeClsId = null;
      r.codeCls = null;
      if (r.matchType === 'CODE') {
        r.matchType = 'MANUAL';
        r.state = 'manual';
      }
      return;
    }
    r.codeClsId = c.codeClsId;
    r.codeCls = { ...c };
    r.matchType = 'CODE';
    r.state = 'code';
    if (r.colComment.trim() === '' || r.commentAuto) {
      r.colComment = `${r.logicalNm.trim()}(${c.bizCd}/${c.codeCls} ${c.codeClsNm})`;
      r.commentAuto = true;
    }
  }

  /**
   * Ctrl+V 여러 줄(T9.8): 첫 줄은 이 행 논리명, 나머지는 뒤의 빈 행을 채우고 모자라면 새 행을 끼운다.
   * 반환 = 채운 행(순서대로) — 화면이 한 번의 batch 요청으로 자동완성한다.
   */
  function pasteLogical(uid: string, lines: readonly string[]): EditorRow[] {
    const list = lines.map((l) => l.trim()).filter((l) => l !== '');
    const start = rows.value.findIndex((r) => r.uid === uid);
    if (start < 0 || list.length === 0) return [];
    const out: EditorRow[] = [];
    let i = start;
    for (const nm of list) {
      let r = rows.value[i];
      if (!r || (out.length > 0 && !isBlankRow(r))) {
        r = blankRow();
        rows.value.splice(i, 0, r);
      }
      r.logicalNm = nm;
      out.push(r);
      i++;
    }
    return out;
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
    const row: EditorRow = {
      ...src,
      uid: newUid(),
      columnId: null,
      physicalNm: `${src.physicalNm}`,
      state: 'manual',
      matchType: 'MANUAL',
      ac: null,
      acError: null,
      prevState: null,
    };
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
  function changeBizArea(
    bizAreaId: number | null,
    oldPrefix: string | null,
    newPrefix: string | null,
  ): void {
    header.bizAreaId = bizAreaId;
    const nm = header.tableNm;
    if (oldPrefix && nm.toUpperCase().startsWith(oldPrefix.toUpperCase())) {
      header.tableNm = `${newPrefix ?? ''}${nm.slice(oldPrefix.length)}`;
    } else if (!oldPrefix && newPrefix && nm.trim() === '') {
      header.tableNm = newPrefix;
    }
  }

  /**
   * 화면이 연결하는 자동완성 훅(API 호출 → beginLoading/applyAutocomplete/endLoading). `force` = 같은 논리명이어도 다시
   * (인라인 등록 직후 재시도·[재적용]).
   */
  const autocomplete = ref<((row: EditorRow, opts?: { force?: boolean }) => Promise<void>) | null>(
    null,
  );
  /** Ctrl+V 여러 줄 → 한 번의 batch 요청(T9.8). */
  const batchAutocomplete = ref<((rows: EditorRow[]) => Promise<void>) | null>(null);
  /** 인라인 등록 카드 [등록 후 적용](§5.9): 등록 → 같은 논리명 자동 재시도. 성공(카드 닫힘)이면 true. */
  const registerTerm = ref<((row: EditorRow) => Promise<boolean>) | null>(null);

  function nextRow(uid: string): EditorRow {
    const i = rows.value.findIndex((x) => x.uid === uid);
    if (i >= 0 && i === rows.value.length - 1) return addRow(uid);
    return rows.value[i + 1] ?? addRow();
  }

  /**
   * 논리명 셀 Enter(§10.4 표 "Enter(논리명) → 자동완성 → 결과 처리 → 다음 행/새 행").
   *  - listbox가 열려 있으면 포커스 항목 선택 후 다음 행
   *  - 자동완성이 필요하면(`needsAutocomplete`) 호출 → similar·unregistered·코드 후보면 행에 머문다(null)
   *  - 이미 받은 결과의 보조 UI가 닫혀 있으면(붙여넣기 일괄) 연다(null)
   * 반환: 다음 포커스 행, 머물면 null.
   */
  async function onLogicalEnter(uid: string): Promise<EditorRow | null> {
    const r = find(uid);
    if (r?.ac?.open === 'list') {
      acChoose(uid);
      return nextRow(uid);
    }
    if (r && autocomplete.value) {
      if (needsAutocomplete(r)) await autocomplete.value(r);
      else if (r.state === 'unregistered' && !r.ac && r.defaultColId === null)
        await autocomplete.value(r, { force: true }); // 저장된 미등록 행 → 카드 다시 열기
      else if (acReopen(uid)) return null;
    }
    const after = find(uid);
    if (after?.ac?.open) return null;
    return nextRow(uid);
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
    baseline.value =
      sentJson === payloadJson.value ? payloadJson.value : sentJsonWithIds(sentJson, r);
  }
  function sentJsonWithIds(sentJson: string, r: TableSaveResponse): string {
    try {
      const p = JSON.parse(sentJson) as { table: unknown; columns: ColumnInput[] };
      p.columns = p.columns.map((c, i) => ({
        ...c,
        columnId: r.columns[i]?.columnId ?? c.columnId,
      }));
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
    batchAutocomplete,
    registerTerm,
    onLogicalEnter,
    nextRow,
    beginLoading,
    endLoading,
    applyAutocomplete,
    acMove,
    acSetFocus,
    acChoose,
    acClose,
    acReopen,
    setReg,
    setCodeCls,
    pasteLogical,
    applySaved,
    markStatus,
    find,
  };
}

export type EditorCore = ReturnType<typeof createEditorCore>;

/** 편집기 화면 스토어(한 번에 테이블 1개). */
export const useEditorStore = defineStore('editor', () => createEditorCore());
