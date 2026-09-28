/**
 * 상한·기본값 상수(설계서 §12.5 "상수 packages/shared/src/limits.ts", §5.3·§5.4·§9.1·§9.4).
 */

/** 자동완성 유사 후보 최대 수(similar 5). */
export const AUTOCOMPLETE_SIMILAR_MAX = 5;
/** 분절 대안 최대 수(alternatives 2). */
export const AUTOCOMPLETE_ALTERNATIVES_MAX = 2;
/** 일괄 자동완성 1회 최대 논리명 수(batch 200). */
export const AUTOCOMPLETE_BATCH_MAX = 200;
/** 코드성 컬럼 후보 최대 수(§5.6 상위 3). */
export const CODE_CANDIDATES_MAX = 3;

/** 엑셀 일괄 등록 행 상한(§9.4). */
export const IMPORT_ROWS_MAX = 20_000;
/** 미리보기 보관(TTL 30분, 사용자당 5건, §9.4). */
export const IMPORT_PREVIEW_TTL_MINUTES = 30;
export const IMPORT_PREVIEW_PER_USER_MAX = 5;

/** 페이지네이션(§9.1: page 1부터, size 기본 20, 최대 200). 화면 선택지는 20/50/100. */
export const PAGE_DEFAULT = 1;
export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_MAX = 200;
export const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;

/** DDL 일괄 생성 1회 최대 테이블 수(§6.10). */
export const DDL_EXPORT_TABLES_MAX = 200;
/** COMMENT_SUMMARY 코드 요약 최대 개수(§6.7). */
export const DDL_CODE_SUMMARY_MAX = 10;

/** 통합 검색 결과 종류별 최대 수(§9.3 P/search). */
export const SEARCH_RESULTS_PER_KIND = 5;

/** 코멘트 저장 상한(§6.5). */
export const COMMENT_MAX_LENGTH = 500;
