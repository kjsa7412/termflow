/**
 * 검증 규칙 코드표(설계서 §5.7 전 행). E = 오류(저장·DDL 생성 차단), W = 경고(저장 가능).
 * 편집기 배지 텍스트와 서버 메시지가 이 상수 하나에서 나온다(§2.5.5).
 * 메시지의 `{name}`은 formatValidationMessage()가 채운다.
 */
export type ValidationSeverity = 'E' | 'W';
export type ValidationTarget = 'column' | 'table' | 'all';

export interface ValidationCodeDef {
  severity: ValidationSeverity;
  /** HTTP 상태를 따로 갖는 오류(409 등). 없으면 422(E) 또는 성공 응답의 warnings(W). */
  httpStatus?: number;
  targets: readonly ValidationTarget[];
  /** 조건 요약(설계서 §5.7 "조건" 열). */
  condition: string;
  message: string;
}

const col = ['column'] as const;
const tbl = ['table'] as const;
const both = ['column', 'table'] as const;

export const VALIDATION_CODES = {
  E_LOGICAL_EMPTY: {
    severity: 'E',
    targets: col,
    condition: '논리명 공백',
    message: '논리명을 입력하세요',
  },
  E_PHYS_EMPTY: {
    severity: 'E',
    targets: col,
    condition: '물리명 공백',
    message: '물리명이 비어 있습니다',
  },
  E_PHYS_FORMAT: {
    severity: 'E',
    targets: both,
    condition: '^[A-Z][A-Z0-9_]*$ 불일치',
    message: '물리명은 영대문자로 시작하고 영대문자·숫자·_만 쓸 수 있습니다',
  },
  E_PHYS_DUP: {
    severity: 'E',
    targets: col,
    condition: '같은 테이블 내 물리명 중복',
    message: '물리명 {physicalNm}이(가) {rowNo}행과 중복됩니다',
  },
  E_PHYS_LEN: {
    severity: 'E',
    targets: both,
    condition: '기본 방언 길이 초과',
    message: '물리명이 {max}자를 초과합니다({dialect})',
  },
  E_RESERVED: {
    severity: 'E',
    targets: both,
    condition: '기본 방언 예약어(quoteIdentifiers=false)',
    message: '{name}은(는) {dialect} 예약어입니다',
  },
  E_TYPE_MISSING: {
    severity: 'E',
    targets: col,
    condition: 'data_type NULL',
    message: '타입을 지정하세요',
  },
  E_TYPE_LEN_MISSING: {
    severity: 'E',
    targets: col,
    condition: 'VARCHAR/CHAR/NUMERIC인데 길이 없음',
    message: '{dataType} 길이가 없습니다',
  },
  E_TYPE_LEN_RANGE: {
    severity: 'E',
    targets: col,
    condition: '길이 ≤ 0, NUMERIC scale > precision, TIMESTAMP n > 6',
    message: '길이 범위 오류입니다',
  },
  E_PK_NULLABLE: {
    severity: 'E',
    targets: col,
    condition: 'is_pk이고 is_nullable',
    message: 'PK 컬럼은 NULL을 허용할 수 없습니다',
  },
  E_TABLE_NM_DUP: {
    severity: 'E',
    targets: tbl,
    condition: '프로젝트 내 물리명 중복',
    message: '같은 이름의 테이블이 있습니다',
  },
  E_VERSION_CONFLICT: {
    severity: 'E',
    httpStatus: 409,
    targets: tbl,
    condition: '낙관적 잠금 실패(§8.1)',
    message: '{savedBy}이(가) {savedAt}에 저장했습니다',
  },
  E_TABLE_FINAL: {
    severity: 'E',
    httpStatus: 409,
    targets: tbl,
    condition: 'FINAL 편집 시도(§8.4)',
    message: '확정 테이블은 편집할 수 없습니다',
  },
  W_PK_NONE: { severity: 'W', targets: tbl, condition: 'PK 컬럼 없음', message: 'PK가 없습니다' },
  W_TERM_UNREGISTERED: {
    severity: 'W',
    targets: col,
    condition: 'match_type UNREGISTERED 또는 물리명에 ?',
    message: '미등록 용어가 남아 있습니다',
  },
  W_TERM_PENDING: {
    severity: 'W',
    targets: col,
    condition: '조각 중 PENDING 용어',
    message: "검토대기 용어 '{termKor}' 사용",
  },
  W_TERM_REJECTED: {
    severity: 'W',
    targets: col,
    condition: '조각 중 REJECTED 용어',
    message: "반려된 용어 '{termKor}' 사용",
  },
  W_TERM_CHANGED: {
    severity: 'W',
    targets: col,
    condition: '재분절 결과 물리명 ≠ 저장값',
    message: '표준이 바뀌었습니다: {before} → {after}',
  },
  W_DOMAIN_TYPE_CHANGED: {
    severity: 'W',
    targets: col,
    condition: 'domain_id 도메인 타입 ≠ 컬럼 타입',
    message: '도메인 타입과 다릅니다',
  },
  W_DOMAIN_REVIEW: {
    severity: 'W',
    targets: col,
    condition: '연결 도메인 review_yn',
    message: '검토 필요 도메인',
  },
  W_SUFFIX_UNREGISTERED: {
    severity: 'W',
    targets: col,
    condition: '접미어가 도메인분류에 없음',
    message: '접미어 {suffix}이(가) 도메인분류에 없습니다',
  },
  W_CODE_CLS_MISSING: {
    severity: 'W',
    targets: col,
    condition: 'code_cls_id NULL이지만 match_type CODE',
    message: '코드구분이 삭제되었습니다',
  },
  W_LEN_OTHER_DIALECT: {
    severity: 'W',
    targets: both,
    condition: '다른 방언 길이 초과',
    message: '{dialect}에서 {max}자를 초과합니다',
  },
  W_RESERVED_OTHER: {
    severity: 'W',
    targets: both,
    condition: '다른 방언 예약어',
    message: '{name}은(는) {dialect} 예약어입니다',
  },
  W_DEFAULT_AS_STRING: {
    severity: 'W',
    targets: col,
    condition: '기본값이 함수처럼 보이나 화이트리스트 밖 → 문자열 처리',
    message: '{defaultVal}을(를) 문자열로 처리합니다',
  },
  W_COMMENT_EMPTY: {
    severity: 'W',
    targets: col,
    condition: '코멘트 없음 → 논리명 사용',
    message: '코멘트가 없어 논리명을 사용합니다',
  },
  W_PREFIX_MISMATCH: {
    severity: 'W',
    targets: tbl,
    condition: '물리명이 업무구분 table_prefix로 시작하지 않음',
    message: '업무구분 {bizCd}의 접두어 {prefix}와 다릅니다',
  },
  E_BIZ_AREA_REQUIRED: {
    severity: 'E',
    targets: tbl,
    condition: '업무구분 미지정',
    message: '업무구분을 선택하세요',
  },
  E_PROJECT_READONLY: {
    severity: 'E',
    httpStatus: 409,
    targets: ['all'],
    condition: '보관 프로젝트·템플릿(비관리자)에 쓰기',
    message: '보관된 프로젝트는 수정할 수 없습니다',
  },
  W_VARCHAR_BYTES: {
    severity: 'W',
    targets: col,
    condition: 'Oracle VARCHAR2 4000바이트 초과 가능(n > 1333) 또는 MySQL 행 크기',
    message: 'Oracle에서 CLOB 사용을 권장합니다',
  },
} as const satisfies Record<string, ValidationCodeDef>;

export type ValidationCode = keyof typeof VALIDATION_CODES;

/** `{name}` 자리표시자를 채운다. 없는 값은 자리표시자를 그대로 둔다. */
export function formatValidationMessage(
  code: ValidationCode,
  params: Record<string, string | number> = {},
): string {
  return VALIDATION_CODES[code].message.replace(/\{(\w+)\}/g, (m, k: string) =>
    params[k] === undefined ? m : String(params[k]),
  );
}

/**
 * §5.7 표 밖에서 API가 쓰는 업무 오류 코드(§4·§7·§9.3). ProblemDetail의 `code`로 나간다.
 */
export const API_ERROR_CODES = {
  E_VALIDATION: '검증 오류',
  E_BAD_REQUEST: '요청 형식 오류',
  E_UNAUTHORIZED: '로그인이 필요합니다',
  E_FORBIDDEN: '권한이 없습니다',
  E_CSRF: 'CSRF 토큰이 올바르지 않습니다',
  E_PASSWORD_CHANGE_REQUIRED: '비밀번호를 변경해야 합니다',
  E_LOCKED: '계정이 잠겼습니다',
  E_NOT_FOUND: '대상을 찾을 수 없습니다',
  E_DUPLICATE_KEY: '이미 존재합니다',
  E_UPLOAD_TOO_LARGE: '업로드 크기 상한을 넘었습니다',
  E_INTERNAL: '서버 오류가 발생했습니다',
  E_SORT_FIELD: '허용되지 않은 정렬 필드입니다',
  E_PROJECT_KEY_DUP: '이미 사용 중인 프로젝트 키입니다',
  E_LAST_PROJECT_ADMIN: '마지막 프로젝트 관리자는 변경할 수 없습니다',
  E_BIZ_AREA_DUP: '같은 업무구분 코드가 있습니다',
  E_BIZ_AREA_IN_USE: '테이블이 있는 업무구분입니다',
  E_BIZ_AREA_NOT_FOUND: '업무구분이 프로젝트에 없습니다',
  E_TEMPLATE_IN_USE: '파생 프로젝트가 있는 템플릿입니다',
  E_TEMPLATE_NO_TABLES: '템플릿에는 테이블·멤버를 만들 수 없습니다',
  // 인증·사용자(단계 4, CR-03 §5)
  E_INVALID_CREDENTIALS: '아이디 또는 비밀번호가 올바르지 않습니다',
  E_PW_CURRENT_MISMATCH: '현재 비밀번호가 올바르지 않습니다',
  E_LOGIN_ID_DUP: '이미 사용 중인 아이디입니다',
  E_LAST_SYS_ADMIN: '마지막 시스템 관리자는 해제·비활성화할 수 없습니다',
  E_SELF_DEACTIVATE: '자기 계정은 비활성화할 수 없습니다',
  E_PROJECT_READONLY: '보관된 프로젝트·템플릿은 수정할 수 없습니다',
  // 프로젝트·멤버·업무구분·템플릿(단계 5, CR-04)
  E_PROJECT_ACTIVE: '보관된 프로젝트만 삭제할 수 있습니다',
  E_CONFIRM_KEY_MISMATCH: '확인용 키가 일치하지 않습니다',
  E_COPY_SOURCE_INVALID: '가져오기 원본을 찾을 수 없거나 사용할 수 없습니다',
  E_COPY_FAILED: '프로젝트 복사 중 오류가 발생해 아무것도 만들지 않았습니다',
  E_MEMBER_DUP: '이미 이 프로젝트의 멤버입니다',
  E_USER_INACTIVE: '비활성 사용자는 멤버로 추가할 수 없습니다',
  E_DEFAULT_COL_SET_NOT_FOUND: '이 프로젝트의 기본컬럼 세트가 아닙니다',
  // 표준 사전(단계 6, CR-05)
  E_TERM_DUP: '같은 한글 용어가 있습니다',
  E_TERM_KOR_EMPTY: '한글 용어를 입력하세요',
  E_TERM_KOR_LEN: '한글 용어는 100자 이내입니다',
  E_TERM_PHYSICAL_EMPTY: '물리약어를 입력하세요',
  E_TERM_PHYSICAL_FORMAT: '물리약어는 영대문자·숫자·_만 쓸 수 있습니다',
  E_TERM_PHYSICAL_LEN: '물리약어는 30자 이내입니다',
  E_TERM_NOT_PENDING: '검토대기 상태가 아닌 용어입니다',
  E_TERM_PENDING_DELETE: '검토대기 용어는 승인 큐에서 승인·반려하세요',
  E_SUFFIX_EMPTY: '접미어를 입력하세요',
  E_SUFFIX_FORMAT: '접미어는 영대문자·숫자·_만 쓸 수 있습니다',
  E_DOMAIN_CLS_DUP: '같은 접미어가 있습니다',
  E_DOMAIN_CLS_IN_USE: '이 접미어를 쓰는 도메인이 있습니다',
  E_DOMAIN_DUP: '같은 논리명의 도메인이 있습니다',
  E_DOMAIN_PARTS_EMPTY: '명칭 1을 입력하세요',
  E_TYPE_UNKNOWN: '표준 타입 12종 중 하나여야 합니다',
  E_CODE_CLS_DUP: '같은 업무구분에 같은 코드구분이 있습니다',
  E_CODE_DUP: '같은 코드구분에 같은 코드가 있습니다',
  E_BIZ_AREA_INACTIVE: '사용 중지된 업무구분에는 코드구분을 추가할 수 없습니다',
  E_DEFAULT_COL_SET_DUP: '같은 이름의 기본컬럼 세트가 있습니다',
  E_DEFAULT_COL_DUP: '세트 안에 같은 물리명의 기본컬럼이 있습니다',
  E_DEFAULT_COL_SET_DEFAULT: '기본 세트는 다른 세트를 기본으로 지정한 뒤 삭제할 수 있습니다',
  E_IMPORT_NOT_FOUND: '일괄 등록 미리보기가 없거나 만료되었습니다(30분)',
  E_IMPORT_FILE: 'xlsx 파일이 아니거나 읽을 수 없습니다',
  E_IMPORT_HEADER: '템플릿 헤더와 다릅니다',
  E_IMPORT_ROWS_MAX: '행 수 상한을 넘었습니다',
  E_IMPORT_EMPTY: '데이터 행이 없습니다',
  E_IMPORT_HAS_ERRORS: '오류 행이 있어 적용하지 않았습니다',
  E_IMPORT_FILE_DUP: '파일 안에서 같은 키가 앞 행에 있습니다',
} as const;
export type ApiErrorCode = keyof typeof API_ERROR_CODES;

/**
 * 복사 엔진 경고(설계서 §4.3·§4.4, `project_copy_log.warnings`·생성 응답 `warnings[]`).
 * §5.7 표(테이블·컬럼 검증) 밖의 코드라 VALIDATION_CODES와 따로 둔다.
 */
export const COPY_WARNING_CODES = {
  W_COPY_SOURCE_MIXED: '용어·도메인분류·도메인의 원본이 서로 다릅니다',
  W_COPY_BIZ_AREA_MISSING: '새 프로젝트에 없는 업무구분의 코드구분은 복사하지 않습니다',
  W_COPY_CODES_EMPTIED: '업무구분을 비우면 코드도 비웁니다',
  W_COPY_NO_DEFAULT_COL_SET: '기본컬럼 세트가 없어 프로젝트 기본 세트를 지정하지 않았습니다',
} as const;
export type CopyWarningCode = keyof typeof COPY_WARNING_CODES;

/**
 * 표준 사전 쓰기·일괄 등록 경고(단계 6, 설계서 §4.5 R8·§5.2 10단계). 저장은 되고 응답 `warnings[]`·미리보기 행에 실린다.
 */
export const STD_WARNING_CODES = {
  W_TERM_PHYSICAL_SHARED: '같은 물리약어를 쓰는 다른 용어가 있습니다(R8)',
  W_TERM_UNREGISTERED: '미등록 조각이 있어 물리명을 만들지 않았습니다(검토필요)',
  W_SUFFIX_UNREGISTERED: '접미어가 도메인분류에 없어 타입을 정하지 못했습니다(검토필요)',
  W_PHYS_LEN: '물리명이 63자를 넘어 저장하지 않았습니다(검토필요)',
  W_DOMAIN_LOGICAL_MISMATCH: '명칭 조각 연결이 논리명과 다릅니다(검토필요)',
  W_DOMAIN_CLS_IN_USE: '이 접미어를 쓰는 도메인의 분류 연결이 해제됩니다',
} as const;
export type StdWarningCode = keyof typeof STD_WARNING_CODES;
