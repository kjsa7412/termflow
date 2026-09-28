/**
 * R4 동의어 참조(§11.2): `same_nm_ref ~ '^\d+$'`(숫자만, 예 '63') → NULL. 그 외 값은 `synonym_ref`로 보존
 * (2차 동의어 관리 입력, `r04_synonym_candidates.csv`).
 */
export type SynonymDecision =
  { kind: 'NONE' } | { kind: 'NULLED'; before: string } | { kind: 'KEPT'; value: string };

export function decideSynonymRef(sameNmRef: string | null): SynonymDecision {
  if (sameNmRef === null || sameNmRef.trim() === '') return { kind: 'NONE' };
  if (/^\d+$/.test(sameNmRef.trim())) return { kind: 'NULLED', before: sameNmRef };
  return { kind: 'KEPT', value: sameNmRef.trim() };
}
