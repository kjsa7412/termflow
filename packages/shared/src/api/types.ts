/**
 * API 응답 타입(설계서 §9.3·§9.5·§5.4). 요청 본문 타입은 schemas/*.ts의 z.infer를 쓴다.
 */
import type {
  CopySourceKind,
  DdlOutputKind,
  Dialect,
  HistoryAction,
  MatchType,
  MemberRole,
  ProjectKind,
  ProjectStatus,
  StdEntityType,
  StdType,
  TableStatus,
  TermStatus,
  TypeSource,
} from '../enums.js';
import type { ValidationIssue } from './problem.js';

/** 페이지 응답(§9.1). */
export interface Page<T> {
  items: T[];
  page: number;
  size: number;
  total: number;
}

// ── 인증·내 계정 ──────────────────────────────────────────────────────────
export interface CsrfResponse {
  token: string;
}
export interface SessionUser {
  id: number;
  loginId: string;
  userNm: string;
  isSysAdmin: boolean;
}
export interface LoginResponse {
  user: SessionUser;
  mustChangePassword: boolean;
  /** 로그인 후 세션 ID가 바뀌므로 CSRF 토큰도 새로 발급된다(PoC T1.5). */
  csrfToken: string;
}
export interface MyProject {
  key: string;
  nm: string;
  role: MemberRole;
  kind: ProjectKind;
  status: ProjectStatus;
}
export interface MeResponse {
  user: SessionUser;
  /** 강제 비밀번호 변경 중이면 true(SPA가 `/me?forcePassword=1`로 고정, §7.6). */
  mustChangePassword: boolean;
  projects: MyProject[];
}

// ── 사용자 관리(/admin/users, §9.3) ─────────────────────────────────────────
export interface AdminUserItem {
  id: number;
  loginId: string;
  userNm: string;
  email: string | null;
  isSysAdmin: boolean;
  isActive: boolean;
  pwChangeRequired: boolean;
  /** 잠금 중(locked_until > 현재). */
  locked: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  projects: { key: string; nm: string; role: MemberRole }[];
}
export interface AdminUserPage extends Page<AdminUserItem> {
  counts: {
    all: number;
    active: number;
    pwPending: number;
    locked: number;
    inactive: number;
    sysAdmin: number;
  };
}
export interface AdminUserCreateResponse {
  user: AdminUserItem;
  /** 서버가 만든 초기 비밀번호(관리자가 직접 지정했으면 없음). 이 응답에서만 1회 제공. */
  temporaryPassword?: string;
}
export interface PasswordResetResponse {
  temporaryPassword: string;
}

// ── 프로젝트 ────────────────────────────────────────────────────────────────
/** 프로젝트 카드(GET /projects, 목업 02_projects). §9.3 필드 + 업무구분별 테이블 수·멤버 수·최근 변경자. */
export interface ProjectCard {
  key: string;
  nm: string;
  description: string | null;
  /** 시스템 관리자는 멤버가 아니어도 ADMIN. 멤버가 아닌 시스템 관리자 보기면 isMember=false. */
  myRole: MemberRole;
  isMember: boolean;
  bizAreas: { bizCd: string; bizNm: string; tableCnt: number; useYn: boolean }[];
  tableCnt: number;
  memberCnt: number;
  lastChangedAt: string | null;
  lastChangedBy: string | null;
  status: ProjectStatus;
  defaultDialect: Dialect;
}

/** 항목별 건수(업무구분·표준 사전 7종). */
export interface StdCounts {
  bizArea: number;
  term: number;
  termApproved: number;
  domainCls: number;
  domain: number;
  codeCls: number;
  code: number;
  defaultColSet: number;
  defaultCol: number;
}

/** 마법사 원본 후보(GET /projects/copy-sources). */
export interface CopySourceItem {
  key: string;
  nm: string;
  kind: ProjectKind;
  status: ProjectStatus;
  counts: StdCounts;
  bizAreas: { bizCd: string; bizNm: string; codeClsCnt: number; codeCnt: number }[];
}
export interface CopySourcesResponse {
  templates: CopySourceItem[];
  projects: CopySourceItem[];
}

/** 항목별 미리보기(POST /projects/copy-preview) — 실제 복사 건수와 같은 SQL 조건으로 센다. */
export interface CopyPreviewItem {
  item: StdEntityType;
  sourceKind: CopySourceKind;
  sourceKey: string | null;
  sourceCnt: number;
  toCopy: number;
  toSkip: number;
  warnings: ValidationIssue[];
}
export interface CopyPreviewResponse {
  items: CopyPreviewItem[];
  /** 용어·도메인분류·도메인 원본이 달라 C3 재검증을 하게 되는지. */
  c3Expected: boolean;
  warnings: ValidationIssue[];
}

export interface CopyItemResult {
  item: StdEntityType;
  sourceKey: string | null;
  sourceKind?: CopySourceKind;
  sourceCnt: number;
  copied: number;
  skipped: number;
  flagged: number;
  elapsedMs?: number;
}
export interface C3Revalidation {
  performed: boolean;
  reason?: string;
  /** 새 프로젝트의 검토필요 도메인 전체 수(원본에서 온 review 포함). 목록 링크와 같은 건수. */
  reviewDomainCnt: number;
  /** 이번 C3 재검증으로 새로 표시한 도메인 수(= DOMAIN 항목 flagged). */
  flaggedCnt: number;
  reviewListUrl: string;
  samples: { domainId: number; logicalNm: string; reason: string }[];
}
export interface ProjectCreateResponse {
  projectKey: string;
  projectId: number;
  batchId: string;
  elapsedMs: number;
  items: CopyItemResult[];
  c3Revalidation: C3Revalidation;
  warnings: ValidationIssue[];
}

export interface BizAreaSummary {
  bizAreaId: number;
  bizCd: string;
  bizNm: string;
  tablePrefix: string | null;
  useYn: boolean;
  sortNo: number;
  tableCnt: number;
  draftCnt: number;
  finalCnt: number;
  reviewCnt: number;
  lastChangedAt: string | null;
  lastChangedBy: string | null;
}

/** 프로젝트 홈 요약(GET P, 목업 03_dashboard). */
export interface ProjectHome {
  project: {
    key: string;
    nm: string;
    description: string | null;
    kind: ProjectKind;
    status: ProjectStatus;
    defaultDialect: Dialect;
    includeDefaultCols: boolean;
    defaultColSetNm: string | null;
    copiedFrom: { key: string; nm: string } | null;
    createdAt: string;
    createdBy: string;
  };
  myRole: MemberRole;
  memberCnt: number;
  bizAreas: BizAreaSummary[];
  tables: { total: number; draft: number; final: number; review: number };
  recentChanges: {
    tableId: number;
    tableNm: string;
    tableLogicalNm: string;
    version: number;
    action: string;
    changeSummary: string | null;
    savedBy: string;
    savedAt: string;
  }[];
  reviewDomainCnt: number;
  pendingTermCnt: number;
}

export interface DefaultColSetInfo {
  setId: number;
  setNm: string;
  isDefault: boolean;
  columns: {
    colSeq: number;
    logicalNm: string;
    physicalNm: string;
    typeText: string | null;
    defaultVal: string | null;
    isPk: boolean;
  }[];
}

/** 프로젝트 설정(GET P/settings). 키는 읽기 전용. */
export interface ProjectSettings {
  projectKey: string;
  projectNm: string;
  description: string | null;
  kind: ProjectKind;
  status: ProjectStatus;
  defaultDialect: Dialect;
  includeDefaultCols: boolean;
  defaultColSetId: number | null;
  defaultColSets: DefaultColSetInfo[];
  copiedFrom: { key: string; nm: string } | null;
  createdAt: string;
  createdBy: string;
}

/** 생성·게시 복사 기록(GET P/copy-log). */
export interface CopyLogItem {
  batchId: string;
  operation: 'CREATE' | 'PUBLISH';
  item: StdEntityType;
  sourceKind: CopySourceKind;
  sourceKey: string | null;
  options: Record<string, unknown>;
  sourceCnt: number;
  copiedCnt: number;
  skippedCnt: number;
  flaggedCnt: number;
  warnings: ValidationIssue[];
  elapsedMs: number;
  copiedBy: string;
  copiedAt: string;
}

// ── 멤버 ────────────────────────────────────────────────────────────────────
export interface MemberItem {
  userId: number;
  loginId: string;
  userNm: string;
  role: MemberRole;
  isSysAdmin: boolean;
  isActive: boolean;
  addedAt: string;
  lastLoginAt: string | null;
}
export interface MemberCandidate {
  userId: number;
  loginId: string;
  userNm: string;
  isSysAdmin: boolean;
  isMember: boolean;
}

// ── 업무구분 ────────────────────────────────────────────────────────────────
export interface BizAreaItem {
  bizAreaId: number;
  bizCd: string;
  bizNm: string;
  tablePrefix: string | null;
  sortNo: number;
  useYn: boolean;
  description: string | null;
  tableCnt: number;
  codeClsCnt: number;
  /** 테이블이 1개 이상이면 코드·접두어·사용 중지 잠금(§4.2). */
  locked: boolean;
  origin: { projectKey: string | null; projectNm: string | null } | null;
}
export interface BizAreaDeletePreview {
  tableCnt: number;
  codeClsCnt: number;
  codeCnt: number;
  referencingColumnCnt: number;
}
export interface BizAreaDeleteResponse {
  deletedCodeCls: number;
  deletedCodes: number;
  affectedColumns: number;
}

// ── 시스템: 프로젝트·템플릿 ───────────────────────────────────────────────
export interface AdminProjectItem {
  key: string;
  nm: string;
  description: string | null;
  status: ProjectStatus;
  memberCnt: number;
  tableCnt: number;
  bizCds: string[];
  copiedFrom: { key: string; nm: string } | null;
  lastChangedAt: string | null;
  createdAt: string;
  createdBy: string;
}
export interface TemplateItem {
  key: string;
  nm: string;
  description: string | null;
  status: ProjectStatus;
  counts: StdCounts;
  /** 이 템플릿을 원본으로 복사한 프로젝트·템플릿 수(project_copy_log·copied_from 기준). 1 이상이면 삭제 불가. */
  derivedCnt: number;
  publishedFrom: { key: string; nm: string } | null;
  createdAt: string;
  createdBy: string;
}

// ── 테이블 ──────────────────────────────────────────────────────────────────
export interface TableSaveResponse {
  tableId: number;
  version: number;
  status: TableStatus;
  columns: { columnId: number; colSeq: number }[];
  changeSummary: string;
  warnings: ValidationIssue[];
}

/** 편집기 테이블 헤더(GET P/tables/{id}, 409 `current.table`). */
export interface TableHeaderItem {
  tableId: number;
  projectKey: string;
  bizAreaId: number;
  bizCd: string;
  bizNm: string;
  tablePrefix: string | null;
  bizUseYn: boolean;
  tableNm: string;
  tableLogicalNm: string;
  description: string | null;
  status: TableStatus;
  version: number;
  finalizedAt: string | null;
  finalizedBy: string | null;
  reviewYn: boolean;
  reviewNote: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  /** updated_by의 사용자 이름(없으면 null — MIGRATION 등). */
  updatedByNm: string | null;
  updatedAt: string;
}

/** 편집기 컬럼 1행(저장 본문 ColumnInput + 표시용 참조 정보). */
export interface TableColumnItem {
  columnId: number;
  colSeq: number;
  logicalNm: string;
  physicalNm: string;
  isPk: boolean;
  dataType: StdType | null;
  dataLength: number | null;
  dataScale: number | null;
  isNullable: boolean;
  defaultVal: string | null;
  colComment: string | null;
  domainId: number | null;
  codeClsId: number | null;
  defaultColId: number | null;
  matchType: MatchType;
  /** 연결 도메인 논리명(배지 툴팁). */
  domainNm: string | null;
  /** 연결 코드구분(코드 칩 `RP/030 채택결과`). */
  codeCls: { codeClsId: number; bizCd: string; codeCls: string; codeClsNm: string } | null;
}

/** GET P/tables/{id} — 테이블 + 컬럼 + 재검증(§5.7, DDL과 같은 규칙). */
export interface TableDetail {
  table: TableHeaderItem;
  columns: TableColumnItem[];
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/** 409 version-conflict 본문(§8.1) — ProblemDetail 확장 필드. */
export interface TableConflict {
  yourVersion: number;
  currentVersion: number;
  savedBy: string;
  savedAt: string;
  current: { table: TableHeaderItem; columns: TableColumnItem[] };
}

/** POST P/tables/validate 응답. */
export interface TableValidateResponse {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/** PUT P/tables/{id}/status 응답. */
export interface TableStatusResponse {
  tableId: number;
  version: number;
  status: TableStatus;
  finalizedAt: string | null;
  finalizedBy: string | null;
}

/** 다른 프로젝트 복제 시 자연키로 찾지 못한 참조(§8.4, NULL로 저장). */
export interface RemapWarning {
  code: 'W_REMAP_DOMAIN' | 'W_REMAP_CODE_CLS' | 'W_REMAP_DEFAULT_COL';
  rowIndex: number;
  columnNm: string;
  field: 'domainId' | 'codeClsId' | 'defaultColId';
  /** 원본 자연키(도메인 논리명 · `biz_cd/code_cls` · 기본컬럼 물리명). */
  sourceKey: string;
  message: string;
}

/** POST P/tables/{id}/clone 201. */
export interface TableCloneResponse {
  tableId: number;
  projectKey: string;
  bizAreaId: number;
  tableNm: string;
  version: number;
  remapWarnings: RemapWarning[];
}

/** 이력 목록 1행(GET P/tables/{id}/history, 스냅샷 본문 제외). */
export interface TableHistoryItem {
  version: number;
  action: HistoryAction;
  changeSummary: string | null;
  savedBy: string;
  savedByNm: string | null;
  savedAt: string;
}

/** 스냅샷 JSON(§8.3, schemaVersion 1). */
export interface TableSnapshotColumn {
  columnId: number | null;
  colSeq: number;
  logicalNm: string;
  physicalNm: string;
  isPk: boolean;
  dataType: StdType | null;
  dataLength: number | null;
  dataScale: number | null;
  isNullable: boolean;
  defaultVal: string | null;
  colComment: string | null;
  domainId: number | null;
  codeClsId: number | null;
  defaultColId: number | null;
  matchType: MatchType;
}
export interface TableSnapshot {
  schemaVersion: 1;
  table: {
    tableId: number;
    projectKey: string;
    bizCd: string;
    bizAreaId: number;
    tableNm: string;
    tableLogicalNm: string;
    description: string | null;
    status: TableStatus;
    version: number;
  };
  columns: TableSnapshotColumn[];
  action: HistoryAction;
  changeSummary: string | null;
  savedBy: string;
  savedAt: string;
  /** CLONE: 원본(프로젝트·테이블·버전). */
  clonedFrom?: { projectKey: string; tableId: number; tableNm: string; version: number };
  /** RESTORE: 복원한 버전. */
  restoredFrom?: number;
  /** UNFINALIZE·FINALIZE 사유(선택). */
  note?: string | null;
}

/** GET P/tables/{id}/history/{version}. */
export interface TableHistoryDetail extends TableHistoryItem {
  snapshot: TableSnapshot;
}

export interface TableListItem {
  tableId: number;
  bizAreaId: number;
  bizCd: string;
  tableNm: string;
  logicalNm: string;
  status: TableStatus;
  version: number;
  colCnt: number;
  updatedBy: string;
  updatedAt: string;
  /** TableValidator 재검증(§5.7, DDL 생성과 같은 규칙) 결과 건수. */
  errorCnt: number;
  warningCnt: number;
  /** 검증 요약(앞 3건 메시지, 목록 배지 툴팁). */
  issues: { code: string; message: string }[];
  reviewYn: boolean;
  reviewNote: string | null;
}

/** GET P/tables — 목록 + 좌측 업무구분 건수(§9.3 bizAreaCounts) + 상태 세그먼트 건수(검색·업무구분 필터 적용 후). */
export interface TablePage extends Page<TableListItem> {
  bizAreaCounts: { bizAreaId: number; cnt: number }[];
  allCnt: number;
  statusCounts: Record<TableStatus, number>;
}

// ── 자동완성(§5.4) ──────────────────────────────────────────────────────────
export interface AutocompleteSegment {
  kor: string;
  physical: string | null;
  matched: boolean;
  termId?: number;
  status?: TermStatus;
  numeric?: boolean;
}
export interface AutocompleteApplied {
  physicalNm: string;
  dataType: StdType | null;
  dataLength: number | null;
  dataScale: number | null;
  typeText: string | null;
  colComment: string;
  domainId: number | null;
  matchType: MatchType;
}
export type AutocompleteType = 'exact' | 'similar' | 'composed' | 'unregistered';
/**
 * 유사 후보 1건(§5.3 ③). `kind: 'composed'`는 편집기의 "조합: …" 행(완전 분절 첫 후보, 마지막에 1개).
 * 편집기가 선택 즉시 적용할 수 있도록 타입 3분할·코멘트를 함께 준다(CR-08 C4).
 */
export interface AutocompleteCandidate {
  kind: 'domain' | 'composed';
  domainId?: number;
  logicalNm: string;
  physicalNm: string;
  dataType: StdType | null;
  dataLength: number | null;
  dataScale: number | null;
  typeText: string | null;
  colComment: string;
  score: number;
  /** composed 후보의 조각(배지). */
  segments?: AutocompleteSegment[];
  reviewYn?: boolean;
}
/** 코드성 후보(§5.6). 선택 시 논리명 = `logicalNm`, code_cls_id·match_type CODE, 도메인 정확일치면 domainId. */
export interface AutocompleteCodeCandidate {
  codeClsId: number;
  bizCd: string;
  bizNm: string;
  codeCls: string;
  codeClsNm: string;
  logicalNm: string;
  physicalNm: string;
  dataType: StdType | null;
  dataLength: number | null;
  dataScale: number | null;
  typeText: string | null;
  colComment: string;
  domainId: number | null;
  codeCnt: number;
  /** 앞 5개 코드 미리보기. */
  codes: { code: string; codeNm: string }[];
  score: number;
}
export interface AutocompleteResponse {
  type: AutocompleteType;
  input: string;
  normalized: string;
  applied: AutocompleteApplied | null;
  segments?: AutocompleteSegment[];
  candidates?: AutocompleteCandidate[];
  alternatives?: { physicalNm: string; segments: AutocompleteSegment[] }[];
  codeCandidates?: AutocompleteCodeCandidate[];
  /** unregistered: 인라인 등록 카드의 한글 용어 후보(첫 항목이 기본값, CR-08 C7). */
  registerCandidates?: string[];
  warnings: ValidationIssue[];
  cacheVersion: number;
  elapsedMs: number;
}
/** POST P/autocomplete/columns/batch — 입력 순서대로. */
export interface AutocompleteBatchResponse {
  items: AutocompleteResponse[];
  cacheVersion: number;
  elapsedMs: number;
}
/** POST P/tables/suggest-name(§5.5). */
export interface TableNameSuggestion {
  tableNm: string;
  prefix: string | null;
  segments: AutocompleteSegment[];
  /** 완전 분절 성공(미매칭 없음). */
  complete: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  cacheVersion: number;
}
/** POST P/standards/terms/inline(§5.4, §4.5). outcome: 신규 PENDING / 반려 → PENDING 갱신 / 이미 있음(그 용어 사용). */
export interface TermInlineResponse {
  termId: number;
  status: TermStatus;
  outcome: 'CREATED' | 'REOPENED' | 'EXISTING';
  termKor: string;
  termPhysical: string | null;
  conflicts: { termKor: string; termPhysical: string }[];
  warnings: ValidationIssue[];
}
/** GET /admin/cache(§5.1). */
export interface CacheEntryItem {
  projectId: number;
  projectKey: string | null;
  projectNm: string | null;
  cacheVersion: number;
  counts: {
    terms: number;
    rejected: number;
    domains: number;
    domainCls: number;
    codeCls: number;
    bizAreas: number;
  };
  loadMs: number;
  loadedAt: string;
  lastUsedAt: string;
}
export interface CacheStatusResponse {
  maxProjects: number;
  idleMinutes: number;
  items: CacheEntryItem[];
  stats: {
    loads: number;
    hits: number;
    evictions: number;
    invalidateCalls: number;
    invalidateEvents: number;
  };
}

// ── DDL ─────────────────────────────────────────────────────────────────────
/** 테이블 1개의 생성 결과(미리보기 이동·"이 테이블만 복사"). */
export interface DdlTableResult {
  tableId: number | null;
  tableNm: string;
  logicalNm: string;
  bizCd: string | null;
  status: TableStatus | null;
  version: number | null;
  colCnt: number;
  sql: string;
  warningCnt: number;
}

export interface DdlResponse {
  dialect: Dialect;
  tableCnt: number;
  /** SINGLE 기준 전체 DDL(헤더 1개 + 테이블 블록, §6.10). */
  sql: string;
  /** 다운로드 시 만들어질 파일(SINGLE: .sql 1개, PER_TABLE: ZIP 안 파일들). */
  files: { name: string; size: number }[];
  tables: DdlTableResult[];
  warnings: ValidationIssue[];
}

/** POST P/ddl/extract output=JSON(§6.11 미리보기). */
export interface DdlExtractResponse {
  dialect: Dialect;
  tableCnt: number;
  rowCnt: number;
  text: string;
  fileName: string;
}

/** GET P/export-logs(§3.5.15). */
export interface ExportLogItem {
  exportId: number;
  dialect: Dialect;
  outputKind: DdlOutputKind;
  tableIds: number[];
  tableCnt: number;
  warningCnt: number;
  /** 첫 테이블 물리명(“3개 (RP_PLND_MAST 외)” 표시용). 삭제된 테이블이면 null. */
  firstTableNm: string | null;
  exportedBy: string;
  exportedByNm: string | null;
  exportedAt: string;
}

// ── 표준 사전(단계 6, §9.3·§9.4·§8.5) ───────────────────────────────────────
/** 같은 물리약어를 쓰는 다른 용어(R8 경고·승인 큐 충돌 표시). */
export interface TermRef {
  termId: number;
  termKor: string;
  termPhysical: string | null;
  status: TermStatus;
}
export interface TermItem {
  termId: number;
  termKor: string;
  termPhysical: string | null;
  description: string | null;
  synonymRef: string | null;
  status: TermStatus;
  reviewYn: boolean;
  reviewNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  /** 같은 물리약어를 쓰는 다른 용어 수(0이면 공유 없음). */
  sharedCnt: number;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}
export interface TermPage extends Page<TermItem> {
  /** 상태 세그먼트 건수(검색어 반영, 상태 필터 제외). */
  counts: { all: number; approved: number; pending: number; rejected: number; shared: number };
}
/** 용어 저장 응답: 저장된 용어 + R8 경고(같은 물리약어 기존 용어). */
export interface TermSaveResponse {
  term: TermItem;
  physicalConflicts: TermRef[];
  warnings: ValidationIssue[];
}
export interface TermCheckResponse {
  korExists: boolean;
  korTerm: TermRef | null;
  physicalUsedBy: TermRef[];
}
export interface TermDetail {
  term: TermItem;
  physicalConflicts: TermRef[];
  /** 이 용어를 명칭 조각으로 쓰는 도메인 수(삭제·물리약어 변경 영향). */
  domainCnt: number;
}

/** 승인 큐 항목(§4.5, 목업 11). */
export interface ApprovalItem extends TermItem {
  /** 같은 물리약어를 쓰는 다른 용어(충돌 경고). */
  physicalConflicts: TermRef[];
  /** 논리명에 이 한글 용어가 들어 있는 컬럼 수(영향 추정). */
  columnCnt: number;
  /** 컬럼 예시(테이블 물리명 · 컬럼 논리명) 최대 3건. */
  columnSamples: { tableNm: string; logicalNm: string }[];
}
export interface ApprovalPage extends Page<ApprovalItem> {
  counts: { pending: number; processed: number };
}
export interface ApprovalBatchResponse {
  approved: number;
  termIds: number[];
}

export interface DomainClsItem {
  domainClsId: number;
  suffix: string;
  clsNm: string;
  colType: StdType;
  colLength: number | null;
  colScale: number | null;
  typeText: string;
  description: string | null;
  reviewYn: boolean;
  /** 이 분류에 연결된 도메인 수. */
  domainCnt: number;
  /** 예시 도메인(논리명·물리명) 1건. */
  sample: { logicalNm: string; physicalNm: string | null } | null;
  updatedBy: string;
  updatedAt: string;
}
export interface DomainClsPage extends Page<DomainClsItem> {
  counts: { all: number; review: number };
}
export interface DomainClsSaveResponse {
  domainCls: DomainClsItem;
  warnings: ValidationIssue[];
}
export interface DomainClsDeleteResponse {
  /** 분류 연결이 해제(domain_cls_id NULL)된 도메인 수. */
  unlinkedDomains: number;
}

/** L1 조각 결과(도메인 미리보기·목록 표시). */
export interface DomainPiece {
  kor: string;
  physical: string;
  matched: boolean;
  numeric: boolean;
}
export interface DomainItem {
  domainId: number;
  nm: (string | null)[];
  logicalNm: string;
  physicalNm: string | null;
  descr: string | null;
  suffix: string | null;
  domainClsId: number | null;
  colType: StdType | null;
  colLength: number | null;
  colScale: number | null;
  typeText: string | null;
  typeSource: TypeSource;
  reviewYn: boolean;
  reviewNote: string | null;
  updatedBy: string;
  updatedAt: string;
}
export interface DomainPage extends Page<DomainItem> {
  counts: { all: number; review: number; noPhysical: number; manual: number };
}
export interface DomainDetail {
  domain: DomainItem;
  pieces: DomainPiece[];
  /** 이 도메인에 연결된 컬럼 수(삭제 시 연결 해제). */
  columnCnt: number;
}
/** L1 미리보기(POST P/standards/domains/calculate, §5.2). */
export interface DomainCalcResult {
  logicalNm: string;
  /** 저장될 물리명(미등록 조각·형식 위반이면 null). */
  physicalNm: string | null;
  /** 조립 결과(미등록 조각은 한글 그대로 — 화면 표시용). */
  assembledPhysical: string;
  descr: string;
  suffix: string | null;
  domainClsId: number | null;
  colType: StdType | null;
  colLength: number | null;
  colScale: number | null;
  typeText: string | null;
  typeSource: TypeSource;
  pieces: DomainPiece[];
  notFound: string[];
  /** 저장 시 review_yn이 켜질 사유(비어 있으면 정상). */
  reviewReasons: string[];
  /** 같은 논리명의 기존 도메인(있으면 저장 409). */
  duplicate: { domainId: number; logicalNm: string } | null;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}
export interface DomainSaveResponse {
  domain: DomainItem;
  warnings: ValidationIssue[];
}
export interface DomainRecalcReportRow {
  domainId: number;
  logicalNm: string;
  changes: Record<string, [unknown, unknown]>;
  reviewYn: boolean;
  reviewNote: string | null;
}
export interface DomainRecalcResponse {
  scope: 'REVIEW_ONLY' | 'ALL_AUTO';
  /** 대상 행 수(REVIEW_ONLY = 검토필요 도메인, ALL_AUTO = AUTO 도메인). */
  target: number;
  updated: number;
  /** 검토필요가 해제된 수. */
  resolved: number;
  /** 대상 중 재계산 후에도 검토필요로 남은 수. */
  stillReview: number;
  batchId: string | null;
  elapsedMs: number;
  /** 바뀐 행(최대 1,000행). */
  report: DomainRecalcReportRow[];
}

export interface CodeClsItem {
  codeClsId: number;
  bizAreaId: number;
  bizCd: string;
  bizNm: string;
  bizUseYn: boolean;
  codeCls: string;
  codeClsNm: string;
  description: string | null;
  codeCnt: number;
  activeCodeCnt: number;
  /** 이 코드구분을 참조하는 컬럼 수. */
  columnCnt: number;
  updatedBy: string;
  updatedAt: string;
}
export interface CodeItem {
  codeId: number;
  codeClsId: number;
  code: string;
  codeNm: string;
  sortOrder: number | null;
  isActive: boolean;
  updatedBy: string;
  updatedAt: string;
}
export interface CodeClsDetail {
  codeCls: CodeClsItem;
  codes: CodeItem[];
  /** 참조 컬럼 예시(테이블.컬럼) 최대 3건. */
  columnSamples: string[];
}
export interface CodeClsDeleteResponse {
  deletedCodes: number;
  affectedColumns: number;
}

export interface DefaultColItem {
  defaultColId: number;
  colSeq: number;
  logicalNm: string;
  physicalNm: string;
  isPk: boolean;
  dataType: StdType;
  dataLength: number | null;
  dataScale: number | null;
  typeText: string;
  isNullable: boolean;
  defaultVal: string | null;
  colComment: string | null;
}
export interface DefaultColSetItem {
  setId: number;
  setNm: string;
  description: string | null;
  isDefault: boolean;
  colCnt: number;
  columns: DefaultColItem[];
  /** 이 세트의 기본컬럼을 참조하는 테이블 컬럼 수. */
  columnRefCnt: number;
  updatedBy: string;
  updatedAt: string;
}

export interface AuditLogItem {
  auditId: number;
  entityType: StdEntityType;
  entityId: number;
  action: string;
  before: unknown;
  after: unknown;
  /** before/after에서 바뀐 필드(UPDATE·IMPORT·APPROVE 등). */
  changedFields: string[];
  batchId: string | null;
  actor: string;
  actorIp: string | null;
  actedAt: string;
}

export interface SearchResponse {
  terms: { termId: number; termKor: string; termPhysical: string | null; status: TermStatus }[];
  domains: {
    domainId: number;
    logicalNm: string;
    physicalNm: string | null;
    typeText: string | null;
    reviewYn: boolean;
  }[];
  /** 테이블 검색은 T7.9에서 추가(현재는 빈 배열). */
  tables: { tableId: number; tableNm: string; logicalNm: string; bizCd: string }[];
}

// ── 엑셀 일괄 등록(§9.4) ────────────────────────────────────────────────────
export interface ImportIssue {
  code: string;
  message: string;
  field?: string;
}
export interface ImportRow {
  rowNo: number;
  status: 'NEW' | 'UPDATE' | 'SKIP' | 'ERROR';
  /** 키(용어 = 한글용어, 도메인 = 계산 논리명, 코드 = 업무구분/코드구분/코드 …). */
  key: string;
  values: Record<string, string | number | boolean | null>;
  /** 갱신 행의 바뀌는 필드 [기존, 새 값]. */
  changes: Record<string, [unknown, unknown]>;
  errors: ImportIssue[];
  warnings: ImportIssue[];
}
export interface ImportSummary {
  new: number;
  update: number;
  skip: number;
  error: number;
  warn: number;
}
export interface ImportPreview extends Page<ImportRow> {
  importId: string;
  kind: string;
  fileName: string;
  totalRows: number;
  summary: ImportSummary;
  /** 표시 열(템플릿 헤더 순서 + 계산 열, 값 키 = values의 키). computed = 서버 계산 값(도메인 L1 결과 등). */
  columns: { key: string; label: string; required: boolean; computed?: boolean }[];
  createdAt: string;
  expiresAt: string;
  elapsedMs: number;
}
export interface ImportApplyResponse {
  applied: { new: number; update: number };
  skipped: number;
  errors: number;
  batchId: string;
  elapsedMs: number;
}
