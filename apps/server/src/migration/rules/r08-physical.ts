/**
 * R8 물리약어 정규화(§11.2): `upper(trim(term_physical))`. `!~ '^[A-Z0-9_]+$'` 또는 NULL이면
 * 숫자 용어(`^\d+$`)는 term_kor로 채우고, 아니면 NULL + review(예: '1차').
 */
const PHYSICAL_RE = /^[A-Z0-9_]+$/;

export type PhysicalDecision =
  | { kind: 'KEEP'; value: string }
  | { kind: 'NORMALIZED'; value: string }
  | { kind: 'FILLED_NUMERIC'; value: string }
  | { kind: 'REVIEW'; note: string };

export function decideTermPhysical(physical: string | null, termKor: string): PhysicalDecision {
  const up = physical === null ? null : physical.trim().toUpperCase();
  if (up !== null && PHYSICAL_RE.test(up)) {
    return up === physical ? { kind: 'KEEP', value: up } : { kind: 'NORMALIZED', value: up };
  }
  if (/^\d+$/.test(termKor)) return { kind: 'FILLED_NUMERIC', value: termKor };
  return {
    kind: 'REVIEW',
    note: up === null || up === '' ? '물리약어 없음' : `물리약어 형식 위반: ${physical}`,
  };
}

/** 같은 physical을 공유하는 용어 그룹(동의어 후보). physical NULL은 제외, physical 오름차순. */
export function synonymGroups(
  terms: readonly { termKor: string; physical: string | null }[],
): { physical: string; terms: string[] }[] {
  const by = new Map<string, string[]>();
  for (const t of terms) {
    if (t.physical === null) continue;
    const list = by.get(t.physical) ?? [];
    list.push(t.termKor);
    by.set(t.physical, list);
  }
  return [...by]
    .filter(([, list]) => list.length > 1)
    .map(([physical, list]) => ({ physical, terms: list }))
    .sort((a, b) => (a.physical < b.physical ? -1 : a.physical > b.physical ? 1 : 0));
}
