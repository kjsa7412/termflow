import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ddlOptionsSchema } from '@termflow/shared';
import { createDb, type Db } from '../../src/db/client.js';
import { dialectFor } from '../../src/ddl/dialects.js';
import { generateTable } from '../../src/ddl/generator.js';
import type { TableModel } from '../../src/ddl/model.js';
import { RESERVED_KEYWORDS_SQL, reservedWords } from '../../src/ddl/reserved-words.js';
import { validateTable } from '../../src/ddl/validator.js';
import {
  regressionCases,
  runDdlRegression,
  syntheticCases,
} from '../../src/migration/ddl-regression.js';
import { parseSteps, type RunSummary } from '../../src/migration/runner.js';
import { loadSuffixes, loadTableModels } from '../../src/table/table-model.loader.js';
import { GOLDEN_DIR, GOLDEN_META, GOLDEN_OPTION_SETS } from '../unit/rp33.js';
import { createDatabase, createMigratedDatabase } from './setup/databases.js';
import { insertUsers, runSteps, tempReportRoot } from './setup/stdv1.js';

/**
 * T7.11 DDL 실행 회귀(설계서 §11.1 step 12, §6.12, G3). `pnpm test:db -- ddl-regression`
 *  1) 승계 러너 1~12 전체(새 DB) → DDL_REGRESSION 33/33(기본 + dropIfExists·CHECK) + 합성, 대조 불일치 0, 종료 코드 0 상당
 *  2) 러너 결과로 만든 DDL = 골든 파일 66(스냅샷 rp33.sql이 러너 결과와 같다는 증명)
 *  3) TermFlow 스키마가 없는 **빈 DB**에서 33 테이블 실행 → information_schema 대조
 *  4) 예약어: 비인용 ORDER는 E_RESERVED로 생성 거부, quoteIdentifiers=true면 실행 성공 · 파일 = 컨테이너 pg_get_keywords
 */
describe('DDL 실행 회귀(G3)', () => {
  let pool: pg.Pool;
  let db: Db;
  let url: string;
  let run: RunSummary;
  let models: TableModel[];
  let rmsId: number;
  const rep = tempReportRoot('tf-ddlreg-');

  beforeAll(async () => {
    url = await createMigratedDatabase('t_ddl_regression');
    pool = new pg.Pool({ connectionString: url, max: 4 });
    db = createDb(pool);
    await insertUsers(pool);
    run = await runSteps(
      { pool, db, url },
      rep.dir,
      'ddlreg',
      parseSteps('LOAD_LEGACY..DDL_REGRESSION'),
    );
    const { rows } = await pool.query<{ project_id: number }>(
      "select project_id from tf_project where project_key = 'RMS'",
    );
    rmsId = rows[0]!.project_id;
    const ids = await pool.query<{ table_id: number }>(
      'select table_id from prj_table where project_id = $1 order by table_nm collate "C"',
      [rmsId],
    );
    models = await loadTableModels(
      db,
      rmsId,
      ids.rows.map((r) => r.table_id),
    );
  });
  afterAll(async () => {
    await pool.end();
    rep.cleanup();
  });

  it('러너 1~12 전 step SUCCESS — DDL_REGRESSION 33/33(기본·DROP+CHECK) + 합성 3/3, 대조 불일치 0', () => {
    for (const s of run.steps)
      console.log(`[test:db ddl-regression] ${s.step} ${s.status} ${s.seconds}s — ${s.message}`);
    expect(run.ok).toBe(true);
    expect(run.steps.map((s) => s.step)).toHaveLength(12);
    expect(run.steps.every((s) => s.status === 'SUCCESS')).toBe(true);
    const step = run.steps.find((s) => s.step === 'DDL_REGRESSION')!;
    expect(step.result).toMatchObject({ source: 33, loaded: 33, flagged: 0 });
    expect(step.result?.rules).toEqual([
      { rule: 'G3', source: 33, loaded: 33, excluded: 0, flagged: 0 },
      { rule: 'G3CK', source: 33, loaded: 33, excluded: 0, flagged: 0 },
      { rule: 'SYNTH', source: 3, loaded: 3, excluded: 0, flagged: 0 },
    ]);
    expect(step.message).toContain('대조 불일치 0');
    const csv = readFileSync(path.join(run.reportDir, 'ddl_regression.csv'), 'utf8')
      .trimEnd()
      .split('\r\n');
    expect(csv).toHaveLength(1 + 33 * 2 + 3);
    expect(csv.slice(1).every((l) => l.split(',')[3] === 'OK')).toBe(true);
  });

  it('러너 결과 33 테이블의 DDL이 골든 파일 66과 같다(rp33 스냅샷 = 러너 결과)', async () => {
    expect(models).toHaveLength(33);
    const suffixes = await loadSuffixes(db, rmsId);
    const pgd = dialectFor('POSTGRESQL');
    let compared = 0;
    for (const [set, partial] of Object.entries(GOLDEN_OPTION_SETS)) {
      const opts = ddlOptionsSchema.parse(partial);
      for (const m of models) {
        const { warnings, errors } = validateTable(m, { dialect: 'POSTGRESQL', suffixes });
        expect(errors).toEqual([]);
        const sql = generateTable(pgd, { model: m, warnings }, opts, GOLDEN_META).sql;
        expect(sql, `${set}/${m.tableNm}`).toBe(
          readFileSync(path.join(GOLDEN_DIR, set, `${m.tableNm}.sql`), 'utf8'),
        );
        compared++;
      }
    }
    expect(compared).toBe(66);
  });

  it('빈 DB(TermFlow 스키마 없음)에서 33 테이블 × 옵션 2 + 합성 실행 → 대조 불일치 0', async () => {
    const emptyUrl = await createDatabase('t_ddl_exec_empty');
    const client = new pg.Client({ connectionString: emptyUrl });
    await client.connect();
    try {
      const results = await runDdlRegression(
        client,
        [...regressionCases(models), ...syntheticCases()],
        {
          schema: 'public',
        },
      );
      const bad = results.filter((r) => !r.ok);
      expect(bad).toEqual([]);
      expect(results).toHaveLength(69);
      expect(results.reduce((n, r) => n + r.columns, 0)).toBe(649 * 2 + 17 * 2 + 3);
      // ROLLBACK으로 아무것도 남지 않는다
      const left = await client.query(
        "select count(*)::int n from pg_tables where schemaname = 'public'",
      );
      expect(left.rows[0]).toEqual({ n: 0 });
    } finally {
      await client.end();
    }
  });

  it('예약어: 비인용 ORDER는 E_RESERVED로 생성 거부, quoteIdentifiers=true면 실행 성공', async () => {
    const reserved = syntheticCases().find((c) => c.set === 'synthetic-reserved-quoted')!;
    const client = await pool.connect();
    try {
      const [unquoted, quoted] = await runDdlRegression(client, [
        { ...reserved, set: 'reserved-unquoted', options: ddlOptionsSchema.parse({}) },
        reserved,
      ]);
      expect(unquoted).toMatchObject({ ok: false });
      expect(unquoted!.error).toMatch(/^검증 오류: .*E_RESERVED/);
      expect(quoted).toMatchObject({ ok: true, mismatches: [] });
    } finally {
      client.release();
    }
  });

  it('이스케이프: 코멘트·기본값의 작은따옴표·역슬래시·개행·탭이 원문대로(개행·탭은 공백) 저장된다', async () => {
    const esc = syntheticCases().find((c) => c.set === 'synthetic-escape')!;
    const sql = generateTable(
      dialectFor('POSTGRESQL'),
      { model: esc.model, warnings: [] },
      esc.options,
      GOLDEN_META,
    ).sql;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('CREATE SCHEMA t_escape');
      await client.query('SET LOCAL search_path TO t_escape');
      await client.query(sql);
      const c = await client.query<{ memo: string; tbl: string; dflt: string }>(
        `select col_description('t_escape.zz_escape'::regclass, 2) memo,
                obj_description('t_escape.zz_escape'::regclass, 'pg_class') tbl,
                (select column_default from information_schema.columns
                  where table_schema = 't_escape' and table_name = 'zz_escape' and column_name = 'quote_val') dflt`,
      );
      expect(c.rows[0]).toEqual({
        memo: "고객's 메모 \\ 끝 탭",
        tbl: "고객's 테이블 (합성)",
        dflt: "'a''b'::character varying",
      });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('예약어 파일(resources/ddl/reserved/postgresql.txt) = 컨테이너 pg_get_keywords() R·T', async () => {
    const { rows } = await pool.query<{ word: string }>(RESERVED_KEYWORDS_SQL);
    expect([...reservedWords('POSTGRESQL')].sort()).toEqual(rows.map((r) => r.word).sort());
  });
});
