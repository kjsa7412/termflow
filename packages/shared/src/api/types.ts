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
export interface ProjectCard {
  key: string;
  nm: string;
  myRole: MemberRole;
  bizAreas: { bizCd: string; bizNm: string }[];
  tableCnt: number;
  lastChangedAt: string | null;
  status: ProjectStatus;
}

export interface CopyItemResult {
  item: StdEntityType;
  sourceKey: string | null;
  sourceKind?: CopySourceKind;
  sourceCnt: number;
  copied: number;
  skipped: number;
  flagged: number;
}
export interface ProjectCreateResponse {
  projectKey: string;
  projectId: number;
  batchId: string;
  elapsedMs: number;
  items: CopyItemResult[];
  c3Revalidation: {
    performed: boolean;
    reason?: string;
    reviewDomainCnt: number;
    reviewListUrl: string;
    samples: { domainId: number; logicalNm: string; reason: string }[];
  };
  warnings: ValidationIssue[];
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
