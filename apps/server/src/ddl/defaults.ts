/**
 * DEFAULT 판정(설계서 §6.6) — 방언 중립. 화이트리스트 밖의 표현식을 그대로 삽입하는 경로는 없다(F3).
 *  - 비어 있음 → 없음 / `NULL`(대소문자 무관) → NULL / `^-?\d+(\.\d+)?$` → 숫자 리터럴
 *  - `CURRENT_TIMESTAMP`·`NOW()` / `CURRENT_DATE`·`SYSDATE` → 함수(화이트리스트), `TRUE`·`FALSE` → 불리언
 *    (§6.6 표의 표기 그대로 **대문자 일치**만 인정 — 표의 "그 외" 예시 `now()`는 문자열 + W_DEFAULT_AS_STRING, CR-06 C3)
 *  - 그 외 전부 → 문자열 리터럴, `(`가 있으면 함수처럼 보이므로 W_DEFAULT_AS_STRING
 */
export type DefaultSpec =
  | { kind: 'NONE' }
  | { kind: 'NULL' }
  | { kind: 'NUMBER'; value: string }
  | { kind: 'FUNCTION'; fn: 'CURRENT_TIMESTAMP' | 'CURRENT_DATE' }
  | { kind: 'BOOLEAN'; value: 'TRUE' | 'FALSE' }
  | { kind: 'STRING'; value: string; looksLikeFunction: boolean };

const NUMBER_RE = /^-?\d+(\.\d+)?$/;
const FUNCTIONS: Record<string, 'CURRENT_TIMESTAMP' | 'CURRENT_DATE'> = {
  CURRENT_TIMESTAMP: 'CURRENT_TIMESTAMP',
  'NOW()': 'CURRENT_TIMESTAMP',
  CURRENT_DATE: 'CURRENT_DATE',
  SYSDATE: 'CURRENT_DATE',
};

export function classifyDefault(raw: string | null | undefined): DefaultSpec {
  if (raw === null || raw === undefined) return { kind: 'NONE' };
  const v = raw.trim();
  if (v === '') return { kind: 'NONE' };
  if (/^null$/i.test(v)) return { kind: 'NULL' };
  if (NUMBER_RE.test(v)) return { kind: 'NUMBER', value: v };
  const fn = FUNCTIONS[v];
  if (fn) return { kind: 'FUNCTION', fn };
  if (v === 'TRUE' || v === 'FALSE') return { kind: 'BOOLEAN', value: v };
  return { kind: 'STRING', value: v, looksLikeFunction: v.includes('(') };
}
