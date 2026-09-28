import type { Dialect } from '../enums.js';

/**
 * 식별자 규칙(§5.7 E_PHYS_FORMAT·E_PHYS_LEN, §6.4). 사용자 테이블·컬럼 물리명은 영대문자로 시작,
 * 영대문자·숫자·_만. DDL 렌더링 직전에도 같은 정규식으로 재검사한다(인젝션 방지, §12.2).
 */
export const IDENTIFIER_RE = /^[A-Z][A-Z0-9_]*$/;

/** 표준 용어 물리약어·접미어(숫자로 시작 가능, §부록 A ck_std_term_physical_fmt). */
export const TERM_PHYSICAL_RE = /^[A-Z0-9_]+$/;
/** 도메인 물리명(ck_std_domain_physical_fmt). */
export const DOMAIN_PHYSICAL_RE = /^[A-Z0-9][A-Z0-9_]*$/;
/** 프로젝트 키·업무구분 코드(ck_tf_project_key_fmt, ck_prj_biz_area_cd_fmt). */
export const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;
export const BIZ_CD_RE = PROJECT_KEY_RE;
/** 업무구분 테이블 접두어(ck_prj_biz_area_prefix_fmt). */
export const TABLE_PREFIX_RE = /^[A-Z][A-Z0-9_]*$/;

/** 방언별 식별자 길이 상한(§5.7: PostgreSQL 63 / Oracle 30(12.1 호환) / MySQL 64). */
export const DIALECT_IDENTIFIER_MAX: Record<Dialect, number> = {
  POSTGRESQL: 63,
  ORACLE: 30,
  MYSQL: 64,
};

export type IdentifierProblem = 'EMPTY' | 'FORMAT' | 'LENGTH';

/** 형식·길이만 판정한다(예약어는 DDL 엔진, 단계 7). */
export function checkIdentifier(name: string, dialect: Dialect): IdentifierProblem | null {
  if (name.trim() === '') return 'EMPTY';
  if (!IDENTIFIER_RE.test(name)) return 'FORMAT';
  if (name.length > DIALECT_IDENTIFIER_MAX[dialect]) return 'LENGTH';
  return null;
}
