/**
 * 오류 응답 형식(RFC 9457 ProblemDetail + `code`·`errors[]`·`warnings[]` 확장, 설계서 §9.2).
 */
export const PROBLEM_TYPE_BASE = 'https://termflow.sjinc.co.kr/problems/';

/**
 * `type` 목록. §9.2 목록 + 형식 오류(400) `bad-request`·미인증(401) `unauthorized`를 더했다
 * (§9.2에 401·400 전용 type이 없어 추가, 게이트 2 보고).
 */
export const PROBLEM_TYPES = [
  'validation',
  'version-conflict',
  'table-finalized',
  'forbidden',
  'csrf',
  'password-change-required',
  'locked',
  'not-found',
  'duplicate-key',
  'upload-too-large',
  'internal',
  'bad-request',
  'unauthorized',
  'conflict',
] as const;
export type ProblemType = (typeof PROBLEM_TYPES)[number];

export function problemTypeUri(type: ProblemType): string {
  return `${PROBLEM_TYPE_BASE}${type}`;
}

/** 검증 항목(§9.2 errors[]·warnings[]). `rowIndex`는 요청 배열의 0-기준 순번. */
export interface ValidationIssue {
  code: string;
  target?: 'table' | 'column' | 'field' | 'all';
  message: string;
  field?: string;
  rowIndex?: number;
  columnId?: number | null;
  /** 컬럼 물리명(DDL 경고 목록·편집기 행 포커스). */
  columnNm?: string;
  tableId?: number;
  tableNm?: string;
}

export interface ProblemDetail {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: string;
  errors?: ValidationIssue[];
  warnings?: ValidationIssue[];
  /** 확장 필드(409 version-conflict의 yourVersion·currentVersion·current 등). */
  [extension: string]: unknown;
}

export const PROBLEM_TITLES: Record<ProblemType, string> = {
  validation: '검증 오류',
  'version-conflict': '저장 충돌',
  'table-finalized': '확정 테이블',
  forbidden: '권한 없음',
  csrf: 'CSRF 토큰 오류',
  'password-change-required': '비밀번호 변경 필요',
  locked: '계정 잠김',
  'not-found': '찾을 수 없음',
  'duplicate-key': '중복',
  'upload-too-large': '업로드 크기 초과',
  internal: '서버 오류',
  'bad-request': '요청 형식 오류',
  unauthorized: '로그인 필요',
  conflict: '처리할 수 없는 상태',
};

export function isProblemDetail(v: unknown): v is ProblemDetail {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as ProblemDetail).type === 'string' &&
    typeof (v as ProblemDetail).status === 'number' &&
    typeof (v as ProblemDetail).code === 'string'
  );
}
