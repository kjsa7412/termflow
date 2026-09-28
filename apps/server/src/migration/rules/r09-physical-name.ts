/**
 * R9 도메인·컬럼 물리명 정규화(§11.2): logical trim, physical `upper(trim)`.
 * 63자 초과·형식 위반은 리포트(자동 수정 없음), Oracle 30자 초과는 W 리포트.
 */
export const PHYSICAL_MAX_POSTGRES = 63;
export const PHYSICAL_MAX_ORACLE = 30;

export interface PhysicalNameCheck {
  value: string | null;
  changed: boolean;
  /** 저장 CHECK 위반(형식)이면 저장할 수 없다. */
  formatError: boolean;
  tooLong: boolean;
  oracleLong: boolean;
}

export function normalizePhysicalName(
  physical: string | null,
  format: RegExp = /^[A-Z0-9][A-Z0-9_]*$/,
): PhysicalNameCheck {
  if (physical === null || physical.trim() === '') {
    return { value: null, changed: false, formatError: false, tooLong: false, oracleLong: false };
  }
  const value = physical.trim().toUpperCase();
  return {
    value,
    changed: value !== physical,
    formatError: !format.test(value),
    tooLong: value.length > PHYSICAL_MAX_POSTGRES,
    oracleLong: value.length > PHYSICAL_MAX_ORACLE,
  };
}
