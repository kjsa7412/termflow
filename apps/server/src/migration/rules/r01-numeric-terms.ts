/**
 * R1 숫자 용어(설계서 §11.2): `'^\d+\.0$'` → 정수 표기(`'1.0'` → `'1'`).
 * 용어(term_kor·term_physical)와 도메인 명칭 조각(nm1..nm7)에 적용한다 — L1 2단계 숫자 판정의 전제(§5.2).
 * dump는 용어가 이미 정수 표기(0건 예상), 도메인 조각에는 `'13.0'` 형태가 남아 있다(PROFILE 추가 확인).
 */
const NUMERIC_DOT_ZERO = /^(\d+)\.0$/;

export function normalizeNumericText(v: string): string;
export function normalizeNumericText(v: string | null): string | null;
export function normalizeNumericText(v: string | null): string | null {
  if (v === null) return null;
  const m = NUMERIC_DOT_ZERO.exec(v.trim());
  return m ? String(Number(m[1])) : v;
}

export function isNumericDotZero(v: string | null | undefined): boolean {
  return v !== null && v !== undefined && NUMERIC_DOT_ZERO.test(v.trim());
}
