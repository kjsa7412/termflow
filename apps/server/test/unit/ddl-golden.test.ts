import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ddlOptionsSchema } from '@termflow/shared';
import { dialectFor } from '../../src/ddl/dialects.js';
import { generateTable } from '../../src/ddl/generator.js';
import { validateTable } from '../../src/ddl/validator.js';
import { GOLDEN_DIR, GOLDEN_META, GOLDEN_OPTION_SETS, rp33Models } from './rp33.js';

/**
 * 골든 파일(T7.10, 설계서 §6.12 — D2로 33 × PostgreSQL × 옵션 2 = 66 파일). 승계 스냅샷 `test/seed/rp33.sql`의 33 테이블을
 * 기본 옵션(D15)·`dropIfExists + CHECK`로 생성해 `test/ddl/golden/postgresql/{default,drop-check}/{TABLE}.sql`과 문자열 비교한다.
 * 갱신은 `UPDATE_GOLDEN=1 pnpm --filter @termflow/server test -- ddl-golden`으로만(매핑·예약어·생성 규칙 변경과 같은 커밋에서).
 */
const UPDATE = process.env['UPDATE_GOLDEN'] === '1';

const pg = dialectFor('POSTGRESQL');
const rp = rp33Models();

describe('DDL 골든 파일 — RMS 33 테이블 × PostgreSQL × 옵션 2', () => {
  it('스냅샷은 33 테이블·649 컬럼이고 검증 오류(E)가 없다', () => {
    expect(rp.models).toHaveLength(33);
    expect(rp.models.reduce((n, t) => n + t.columns.length, 0)).toBe(649);
    const errors = rp.models.flatMap(
      (t) => validateTable(t, { dialect: 'POSTGRESQL', suffixes: rp.suffixes }).errors,
    );
    expect(errors).toEqual([]);
  });

  for (const [set, partial] of Object.entries(GOLDEN_OPTION_SETS)) {
    const opts = ddlOptionsSchema.parse(partial);
    describe(set, () => {
      it.each(rp.models.map((m) => [m.tableNm, m] as const))('%s', (name, model) => {
        const { warnings } = validateTable(model, { dialect: 'POSTGRESQL', suffixes: rp.suffixes });
        const sql = generateTable(pg, { model, warnings }, opts, GOLDEN_META).sql;
        const file = path.join(GOLDEN_DIR, set, `${name}.sql`);
        if (UPDATE) {
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, sql, 'utf8');
        }
        expect(existsSync(file), `골든 파일 없음: ${file} (UPDATE_GOLDEN=1로 생성)`).toBe(true);
        expect(sql).toBe(readFileSync(file, 'utf8'));
      });
    });
  }

  it('골든 디렉터리에 66 파일만 있다(남은 파일 없음)', () => {
    const files = Object.keys(GOLDEN_OPTION_SETS).flatMap((set) =>
      readdirSync(path.join(GOLDEN_DIR, set)).map((f) => `${set}/${f}`),
    );
    expect(files).toHaveLength(66);
    const expected = Object.keys(GOLDEN_OPTION_SETS).flatMap((set) =>
      rp.models.map((m) => `${set}/${m.tableNm}.sql`),
    );
    expect(files.sort()).toEqual(expected.sort());
  });
});
