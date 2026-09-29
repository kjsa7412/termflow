/**
 * API 응답 타입(설계서 §9.3·§9.5·§5.4). 요청 본문 타입은 schemas/*.ts의 z.infer를 쓴다.
 */
import type {
  CopySourceKind,
  Dialect,
  MatchType,
  MemberRole,
  ProjectKind,
  ProjectStatus,
  StdEntityType,
  StdType,
  TableStatus,
  TermStatus,
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

export interface TableListItem {
  tableId: number;
  bizCd: string;
  tableNm: string;
  logicalNm: string;
  status: TableStatus;
  version: number;
  colCnt: number;
  updatedBy: string;
  updatedAt: string;
  warningCnt: number;
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
export interface AutocompleteResponse {
  type: 'exact' | 'similar' | 'composed' | 'unregistered';
  input: string;
  normalized: string;
  applied: AutocompleteApplied | null;
  segments?: AutocompleteSegment[];
  candidates?: {
    kind: 'domain' | 'composed';
    domainId?: number;
    logicalNm: string;
    physicalNm: string;
    typeText: string | null;
    score: number;
  }[];
  alternatives?: { physicalNm: string; segments: AutocompleteSegment[] }[];
  codeCandidates?: {
    codeClsId: number;
    bizCd: string;
    bizNm: string;
    codeCls: string;
    codeClsNm: string;
    physicalNm: string;
    typeText: string;
    colComment: string;
    codeCnt: number;
  }[];
  warnings: ValidationIssue[];
  cacheVersion: number;
  elapsedMs: number;
}
export interface TermInlineResponse {
  termId: number;
  status: TermStatus;
  conflicts: { termKor: string; termPhysical: string }[];
}

// ── DDL ─────────────────────────────────────────────────────────────────────
export interface DdlResponse {
  dialect: Dialect;
  tableCnt: number;
  sql: string;
  files: { name: string; size: number }[];
  warnings: ValidationIssue[];
}
