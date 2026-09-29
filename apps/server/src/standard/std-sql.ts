import { sql, type SQL } from 'drizzle-orm';
import type { PageQuery, ValidationIssue } from '@termflow/shared';
import { parseSort, type SortWhitelist } from '../common/pagination.js';
import { ValidationProblem } from '../common/problem/problem.exception.js';

export { isoTs, likePattern, rowsOf, type ExecQ } from '../project/sql-util.js';

/**
 * 표준 사전 목록 공통(T6.1, §9.1): 정렬 화이트리스트 → ORDER BY(마지막에 PK로 안정 정렬), LIMIT/OFFSET.
 * 식별자·정렬 필드는 문자열로 SQL에 넣지 않는다(§12.2) — 화이트리스트 값은 코드에 고정된 `sql` 조각이다.
 * 문자열 정렬은 `collate "C"`: DB 기본 콜레이션(en_US.utf8)의 한글 비교가 느리다(도메인 4,587건 정렬 약 0.8초 → 수 ms).
 * 한글 음절(U+AC00~)은 코드 포인트 순서가 가나다순이라 결과 순서도 같다(CR-05 C7).
 */
export function orderBy(
  sort: readonly string[],
  whitelist: SortWhitelist,
  fallback: SQL,
  tiebreak: SQL,
): SQL {
  const parts = sort.length > 0 ? parseSort(sort, whitelist) : [fallback];
  return sql.join([...parts, tiebreak], sql`, `);
}

export function limitOffset(q: PageQuery): SQL {
  return sql`limit ${q.size} offset ${(q.page - 1) * q.size}`;
}

/** 조건 목록 → `where a and b …`(빈 목록이면 true). */
export function whereAll(conds: (SQL | undefined | null | false)[]): SQL {
  const list = conds.filter((c): c is SQL => Boolean(c));
  return list.length === 0 ? sql`true` : sql.join(list, sql` and `);
}

/** 422 업무 검증 오류(errors 1건 이상일 때만). */
export function throwIfErrors(errors: ValidationIssue[], warnings: ValidationIssue[] = []): void {
  if (errors.length > 0) throw new ValidationProblem(errors, warnings);
}

/** 두 행 객체(감사 JSON)에서 바뀐 필드 이름. */
export function changedFields(before: unknown, after: unknown): string[] {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return [];
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  return [...keys].filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]));
}

/** 배열을 n개씩 나눈다(파라미터 상한 65,535 회피 — 일괄 등록·재계산). */
export function chunks<T>(arr: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
