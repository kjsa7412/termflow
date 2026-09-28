import { PgDialect } from 'drizzle-orm/pg-core';
import { pageQuerySchema } from '@termflow/shared';
import { describe, expect, it } from 'vitest';
import { pageArgs, parseSort, toPage } from '../../src/common/pagination.js';
import { BadRequestProblem } from '../../src/common/problem/problem.exception.js';
import { stdTerm } from '../../src/db/schema.js';

// T2.8 페이지네이션·정렬 화이트리스트(§9.1, §12.2)
const dialect = new PgDialect();
const whitelist = { termKor: stdTerm.termKor, updatedAt: stdTerm.updatedAt };

describe('pagination', () => {
  it('page/size 기본값·상한, offset 계산', () => {
    const q = pageQuerySchema.parse({ page: '3', size: '50' });
    expect(pageArgs(q)).toEqual({ limit: 50, offset: 100 });
    expect(pageQuerySchema.parse({})).toEqual({ page: 1, size: 20 });
    expect(pageQuerySchema.safeParse({ size: '201' }).success).toBe(false);
    expect(pageQuerySchema.safeParse({ page: '0' }).success).toBe(false);
    expect(toPage(['a'], 41, q)).toEqual({ items: ['a'], page: 3, size: 50, total: 41 });
  });

  it('허용 필드는 ORDER BY 식으로 변환(방향 생략 = asc)', () => {
    const order = parseSort(['termKor', 'updatedAt,DESC'], whitelist);
    expect(order.map((o) => dialect.sqlToQuery(o).sql)).toEqual([
      '"std_term"."term_kor" asc',
      '"std_term"."updated_at" desc',
    ]);
    expect(parseSort([], whitelist)).toEqual([]);
  });

  it('허용 외 필드·잘못된 방향·SQL 조각은 400 E_SORT_FIELD', () => {
    for (const bad of ['password_hash', 'termKor,sideways', 'termKor;drop table x', 'toString']) {
      try {
        parseSort([bad], whitelist);
        expect.unreachable(bad);
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestProblem);
        const p = (e as BadRequestProblem).toProblem();
        expect(p.status).toBe(400);
        expect(p.code).toBe('E_SORT_FIELD');
        expect(p['errors']).toMatchObject([{ code: 'E_SORT_FIELD', field: 'sort' }]);
      }
    }
  });
});
