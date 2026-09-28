import { asc, desc, type AnyColumn, type SQL } from 'drizzle-orm';
import type { Page, PageQuery } from '@termflow/shared';
import { BadRequestProblem } from './problem/problem.exception.js';

/**
 * 페이지네이션·정렬(설계서 §9.1, §12.2, T2.8). 정렬 필드는 화이트리스트 매핑으로만 SQL이 된다
 * (문자열 삽입 금지). page·size 검증은 공유 스키마 `pageQuerySchema`(size 최대 200)가 한다.
 */
export function pageArgs(q: PageQuery): { limit: number; offset: number } {
  return { limit: q.size, offset: (q.page - 1) * q.size };
}

export function toPage<T>(items: T[], total: number, q: PageQuery): Page<T> {
  return { items, page: q.page, size: q.size, total };
}

/** API 정렬 필드명 → 컬럼(또는 SQL 식). */
export type SortWhitelist = Readonly<Record<string, AnyColumn | SQL>>;

/**
 * `sort=field,asc|desc`(복수)를 ORDER BY 식으로 바꾼다. 방향 생략 시 asc.
 * 화이트리스트 밖 필드·잘못된 방향은 400 `E_SORT_FIELD`.
 */
export function parseSort(sort: readonly string[], whitelist: SortWhitelist): SQL[] {
  return sort.map((item) => {
    const [field = '', dir = 'asc', ...rest] = item.split(',').map((s) => s.trim());
    const target = Object.hasOwn(whitelist, field) ? whitelist[field] : undefined;
    const direction = dir.toLowerCase();
    if (!target || rest.length > 0 || (direction !== 'asc' && direction !== 'desc')) {
      throw new BadRequestProblem(
        [
          {
            code: 'E_SORT_FIELD',
            target: 'field',
            field: 'sort',
            message: `허용되지 않은 정렬: '${item}'. 허용 필드: ${Object.keys(whitelist).join(', ')} (asc|desc)`,
          },
        ],
        '허용되지 않은 정렬 필드입니다',
        'E_SORT_FIELD',
      );
    }
    return direction === 'desc' ? desc(target) : asc(target);
  });
}
