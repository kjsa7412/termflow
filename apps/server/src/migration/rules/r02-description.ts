/**
 * R2 설명 정리(§11.2): `length(description) <= 1 OR description = term_kor OR description ~ '^\s*$'` → NULL.
 * 이미 NULL이면 대상이 아니다(SQL 조건과 같이 NULL 비교는 거짓).
 */
export function shouldNullDescription(description: string | null, termKor: string): boolean {
  if (description === null) return false;
  return description.length <= 1 || description === termKor || /^\s*$/.test(description);
}
