import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/db/client.js';
import type { RunOptions, StepDef, StepName } from '../../src/migration/context.js';
import { ResetRefusedError, runSeed, type RunSummary } from '../../src/migration/runner.js';
import { STAGE3_STEPS } from '../../src/migration/steps/index.js';
import { createMigratedDatabase } from './setup/databases.js';

// T3.14 dump 전체 적재 통합(`pnpm test:db -- migration`) + T3.2 러너 골격 + 게이트 3 멱등성
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const DUMP = path.join(ROOT, 'seed', 'original', 'dump-gen_table-new.sql');
const PHASE1: StepName[] = [
  'LOAD_LEGACY',
  'TEMPLATE',
  'BIZ_AREA',
  'DOMAIN_CLS',
  'TERM',
  'DOMAIN',
  'CODE',
  'DEFAULT_COL',
  'RECONCILE',
];

const reportRoot = mkdtempSync(path.join(tmpdir(), 'tf-migration-'));
afterAll(() => rmSync(reportRoot, { recursive: true, force: true }));

function options(
  url: string,
  runId: string,
  steps: StepName[],
  extra: Partial<RunOptions> = {},
): RunOptions {
  return {
    runId,
    steps,
    reset: false,
    nodeEnv: 'test',
    dumpPath: DUMP,
    reportRoot,
    workDir: path.join(reportRoot, 'work'),
    connection: { connectionString: url },
    ...extra,
  };
}

async function counts(pool: pg.Pool) {
  const { rows } = await pool.query<Record<string, number>>(`
    select (select count(*) from prj_biz_area)::int biz, (select count(*) from std_domain_cls)::int cls,
           (select count(*) from std_term)::int term, (select count(*) from std_term where status = 'APPROVED')::int term_approved,
           (select count(*) from std_domain)::int dom, (select count(*) from std_domain where review_yn)::int dom_review,
           (select count(*) from std_code_cls)::int code_cls, (select count(*) from std_code)::int code,
           (select count(*) from std_default_col_set)::int dset, (select count(*) from std_default_col)::int dcol`);
  return rows[0]!;
}

/** ID를 뺀 내용 해시(재실행 전후 비교). */
async function contentHash(pool: pg.Pool): Promise<string> {
  const { rows } = await pool.query<{ h: string }>(`
    select md5(string_agg(concat_ws('|', d.logical_nm, d.nm1, d.nm2, d.nm3, d.physical_nm, d.descr, d.suffix, c.suffix,
      d.col_type, d.col_length, d.col_scale, d.type_source, d.review_yn, d.review_note, d.created_at, d.updated_at),
      '#' order by d.logical_nm)) ||
      (select md5(string_agg(concat_ws('|', term_kor, term_physical, description, synonym_ref, review_yn), '#' order by term_kor)) from std_term) h
    from std_domain d left join std_domain_cls c on c.domain_cls_id = d.domain_cls_id`);
  return rows[0]!.h;
}

/** 테스트용 CSV 한 줄 파서(따옴표·쉼표). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const stepStatus = (s: RunSummary) => Object.fromEntries(s.steps.map((x) => [x.step, x.status]));
const csvRows = (s: RunSummary, file: string) =>
  readFileSync(path.join(s.reportDir, `${file}.csv`), 'utf8')
    .replace(String.fromCharCode(0xfeff), '')
    .trimEnd()
    .split('\r\n')
    .slice(1);

describe('러너 골격(T3.2)', () => {
  let pool: pg.Pool;
  let db: Db;
  beforeAll(async () => {
    const url = await createMigratedDatabase('t_mig_runner');
    pool = new pg.Pool({ connectionString: url, max: 3 });
    db = createDb(pool);
  });
  afterAll(() => pool.end());

  it('더미 step: 1회차 로그 1행 SUCCESS → 2회차 SKIPPED, 실패 step은 FAILED + ok=false', async () => {
    let done = false;
    const dummy: StepDef = {
      name: 'TEMPLATE',
      isDone: () => Promise.resolve(done),
      run: () => {
        done = true;
        return Promise.resolve({ source: 0, loaded: 0, excluded: 0, flagged: 0 });
      },
    };
    const steps = new Map<StepName, StepDef>([['TEMPLATE', dummy]]);
    const url = '';
    const first = await runSeed(options(url, 'run-a', ['TEMPLATE']), {
      pool,
      db,
      steps,
      log: () => {},
    });
    expect(first.ok).toBe(true);
    const a = await pool.query("select step, status from migration_log where run_id = 'run-a'");
    expect(a.rows).toEqual([{ step: 'TEMPLATE', status: 'SUCCESS' }]);
    const second = await runSeed(options(url, 'run-b', ['TEMPLATE']), {
      pool,
      db,
      steps,
      log: () => {},
    });
    expect(stepStatus(second)).toEqual({ TEMPLATE: 'SKIPPED' });
    expect(existsSync(path.join(second.reportDir, 'summary.csv'))).toBe(true);

    const failing: StepDef = {
      name: 'TERM',
      isDone: () => Promise.resolve(false),
      run: () => Promise.reject(new Error('boom')),
    };
    const third = await runSeed(options(url, 'run-c', ['TEMPLATE', 'TERM']), {
      pool,
      db,
      steps: new Map<StepName, StepDef>([
        ['TERM', failing],
        ['TEMPLATE', dummy],
      ]),
      log: () => {},
    });
    expect(third.ok).toBe(false);
    expect(stepStatus(third)).toEqual({ TEMPLATE: 'SKIPPED', TERM: 'FAILED' });
  });

  it('구현되지 않은 step 요청은 실행 전에 거부, --reset은 production에서 거부', async () => {
    await expect(
      runSeed(options('', 'run-d', ['COPY_TO_RMS']), {
        pool,
        db,
        steps: STAGE3_STEPS,
        log: () => {},
      }),
    ).rejects.toThrow(/구현되지 않았습니다/);
    await expect(
      runSeed(options('', 'run-e', ['TEMPLATE'], { reset: true, nodeEnv: 'production' }), {
        pool,
        db,
        steps: STAGE3_STEPS,
        log: () => {},
      }),
    ).rejects.toThrow(ResetRefusedError);
  });
});

describe('승계 1차 전체(dump → STDV1, 게이트 3)', () => {
  let pool: pg.Pool;
  let db: Db;
  let url: string;
  let first: RunSummary;
  const logs: string[] = [];
  beforeAll(async () => {
    url = await createMigratedDatabase('t_mig_full');
    pool = new pg.Pool({ connectionString: url, max: 4 });
    db = createDb(pool);
    first = await runSeed(options(url, 'full-1', PHASE1), {
      pool,
      db,
      steps: STAGE3_STEPS,
      log: (m) => logs.push(m),
    });
    console.log(`[test:db migration] 러너 1차 실행 ${first.seconds}s`);
  });
  afterAll(() => pool.end());

  it('종료 코드 0 상당(ok), 전 step SUCCESS, 60초 이내', () => {
    expect(first.ok).toBe(true);
    expect(new Set(Object.values(stepStatus(first)))).toEqual(new Set(['SUCCESS']));
    expect(first.seconds).toBeLessThan(60);
  });

  it('LOAD_LEGACY: legacy 건수 = §11.4 원본 열(T3.3)', async () => {
    const { rows } = await pool.query(`select
      (select count(*) from legacy.tb_term_dict)::int term, (select count(*) from legacy.tb_domain_cls)::int cls,
      (select count(*) from legacy.tb_domain)::int dom, (select count(*) from legacy.tb_code_info)::int code,
      (select count(*) from legacy.tb_default_col)::int dcol, (select count(*) from legacy.tb_table_schema)::int tbl,
      (select count(*) from legacy.tb_column_schema)::int col`);
    expect(rows[0]).toEqual({
      term: 1705,
      cls: 54,
      dom: 4587,
      code: 991,
      dcol: 9,
      tbl: 33,
      col: 649,
    });
  });

  it('STDV1 건수: 업무구분 6·분류 84·용어 1,705(APPROVED)·도메인 4,587·코드구분 159·코드 991·기본컬럼 9', async () => {
    expect(await counts(pool)).toMatchObject({
      biz: 6,
      cls: 84,
      term: 1705,
      term_approved: 1705,
      dom: 4587,
      code_cls: 159,
      code: 991,
      dset: 1,
      dcol: 9,
    });
    const p = await pool.query(
      "select kind, default_dialect, default_col_set_id is not null has_set, created_by from tf_project where project_key = 'STDV1'",
    );
    expect(p.rows[0]).toEqual({
      kind: 'TEMPLATE',
      default_dialect: 'POSTGRESQL',
      has_set: true,
      created_by: 'MIGRATION',
    });
  });

  it('BIZ_AREA(T3.7): AC·BD·CT·GW·PS·RP, 접두어 = 코드 + _', async () => {
    const { rows } = await pool.query(
      'select biz_cd, table_prefix, sort_no from prj_biz_area order by sort_no',
    );
    expect(rows.map((r) => r.biz_cd)).toEqual(['AC', 'BD', 'CT', 'GW', 'PS', 'RP']);
    expect(rows.every((r) => r.table_prefix === `${r.biz_cd}_`)).toBe(true);
  });

  it('DOMAIN_CLS(T3.8): 84행, r03 길이 변환 35건(+ TIMESTAMP(n) 1건), 신규 30', async () => {
    const r03 = csvRows(first, 'r03_domain_cls_length');
    expect(r03.filter((l) => l.split(',')[5] === 'col_length')).toHaveLength(35);
    expect(r03.filter((l) => l.split(',')[5] === 'col_type')).toHaveLength(1);
    const { rows } = await pool.query(
      "select col_type, col_length, col_scale from std_domain_cls where suffix in ('RTE','DTS','CD','INFO') order by suffix",
    );
    expect(rows).toEqual([
      { col_type: 'VARCHAR', col_length: 10, col_scale: null },
      { col_type: 'TIMESTAMP', col_length: 0, col_scale: null },
      { col_type: 'VARCHAR', col_length: 200, col_scale: null },
      { col_type: 'NUMERIC', col_length: 7, col_scale: 4 },
    ]);
  });

  it('TERM(T3.9): R2 NULL 36(1자 이하 6 + 용어와 동일 30)·R4 NULL 2/보존 415·R8 NULL+검토 1(1차)·동의어 그룹 190', async () => {
    expect(csvRows(first, 'r02_description_null')).toHaveLength(36);
    const r04 = csvRows(first, 'r04_synonym_candidates');
    expect(r04.filter((l) => l.includes(',NULLED,'))).toHaveLength(2);
    expect(r04.filter((l) => l.includes(',NORMALIZED,'))).toHaveLength(415);
    const { rows } = await pool.query('select term_kor from std_term where term_physical is null');
    expect(rows).toEqual([{ term_kor: '1차' }]);
    expect(csvRows(first, 'r08_synonym_groups')).toHaveLength(190);
    const mtrc = await pool.query("select term_physical from std_term where term_kor = '지표'");
    expect(mtrc.rows[0]).toEqual({ term_physical: 'MTRC' });
  });

  it('DOMAIN(T3.10): 4,587행, R5·R15 리포트, 미등록 조각 리포트, review 건수 기록', async () => {
    const d = first.steps.find((s) => s.step === 'DOMAIN')!;
    expect(d.result?.loaded).toBe(4587);
    const r5 = d.result?.rules?.find((r) => r.rule === 'R05');
    expect(r5).toMatchObject({ source: 558, flagged: 233 });
    expect(r5!.loaded).toBe(82 + 243);
    const r15 = d.result?.rules?.find((r) => r.rule === 'R15');
    expect(r15).toMatchObject({ source: 132, flagged: 132 });
    expect(csvRows(first, 'r15_unregistered_parts').length).toBeGreaterThan(100);
    const { rows } =
      await pool.query(`select count(*) filter (where type_source = 'MANUAL')::int manual,
      count(*) filter (where physical_nm is null)::int phys_null, count(*) filter (where review_yn)::int review from std_domain`);
    expect(rows[0]).toEqual({ manual: 82 + 294, phys_null: 132, review: d.result!.flagged });
    // R1: 명칭 조각 소수 표기가 남지 않는다
    const dot = await pool.query(
      "select count(*)::int n from std_domain where concat(nm1,nm2,nm3,nm4,nm5,nm6,nm7) ~ '\\d\\.0'",
    );
    expect(dot.rows[0]).toEqual({ n: 0 });
    // R13: 원본 일시 유지
    const t = await pool.query(
      "select to_char(d.created_at, 'YYYY-MM-DD HH24:MI:SS') a, to_char(l.firs_reg_dts, 'YYYY-MM-DD HH24:MI:SS') b, d.created_by from std_domain d join legacy.tb_domain l on l.logical_nm = d.logical_nm limit 1",
    );
    expect(t.rows[0].a).toBe(t.rows[0].b);
    expect(t.rows[0].created_by).toBe('MIGRATION');
  });

  it('CODE(T3.11): 코드구분 159·코드 991, 업무구분 전부 STDV1 소속, sort_order 원본 순', async () => {
    const { rows } = await pool.query(
      `select count(*)::int n from std_code_cls c join prj_biz_area b on b.biz_area_id = c.biz_area_id and b.project_id = c.project_id`,
    );
    expect(rows[0]).toEqual({ n: 159 });
    const s = await pool.query(
      `select c.code, c.sort_order from std_code c join std_code_cls k on k.code_cls_id = c.code_cls_id join prj_biz_area b on b.biz_area_id = k.biz_area_id where b.biz_cd = 'RP' and k.code_cls = '010' order by c.sort_order`,
    );
    expect(s.rows.map((r) => r.code)).toEqual(['010', '020', '030', '040']);
  });

  it("DEFAULT_COL(T3.12): 세트 '기본' + 9행, TIMESTAMP(0) 3분할, 기본값 CURRENT_TIMESTAMP 보존", async () => {
    const { rows } = await pool.query(
      "select physical_nm, data_type, data_length, default_val from std_default_col where physical_nm in ('FIRS_REG_DTS','WRK_RMK') order by col_seq",
    );
    expect(rows).toEqual([
      { physical_nm: 'WRK_RMK', data_type: 'VARCHAR', data_length: 100, default_val: null },
      {
        physical_nm: 'FIRS_REG_DTS',
        data_type: 'TIMESTAMP',
        data_length: 0,
        default_val: 'CURRENT_TIMESTAMP',
      },
    ]);
  });

  it('RECONCILE(T3.13): reconcile.csv 원본 = 적재 + 제외 100%, RMS 행은 N/A', () => {
    const rec = csvRows(first, 'reconcile').map(parseCsvLine);
    expect(rec).toHaveLength(9);
    const result = (r: string[]) => r[7];
    expect(rec.filter((r) => result(r) === 'MISMATCH')).toHaveLength(0);
    expect(rec.filter((r) => result(r) === 'OK').map((r) => r[0])).toEqual([
      '업무구분',
      '도메인분류',
      '용어',
      '도메인',
      '코드구분',
      '코드',
      '기본컬럼',
    ]);
    expect(rec.filter((r) => result(r) === 'N/A').map((r) => r[0])).toEqual(['테이블', '컬럼']);
    // 원본 = 적재 + 제외(도메인분류는 legacy 54 + 신규 30 = 84)
    for (const r of rec.filter((x) => result(x) === 'OK' && x[0] !== '도메인분류')) {
      expect(Number(r[1])).toBe(Number(r[3]) + Number(r[2]));
    }
    expect(csvRows(first, 'summary').length).toBeGreaterThan(9);
  });

  it('재실행: 전 step SKIPPED(RECONCILE만 SUCCESS), 건수·내용 변화 없음', async () => {
    const before = [await counts(pool), await contentHash(pool)];
    const again = await runSeed(options(url, 'full-2', PHASE1), {
      pool,
      db,
      steps: STAGE3_STEPS,
      log: () => {},
    });
    expect(again.ok).toBe(true);
    const st = stepStatus(again);
    expect(
      Object.entries(st)
        .filter(([k]) => k !== 'RECONCILE')
        .every(([, v]) => v === 'SKIPPED'),
    ).toBe(true);
    expect(st['RECONCILE']).toBe('SUCCESS');
    expect([await counts(pool), await contentHash(pool)]).toEqual(before);
  });

  it('--reset 후 재실행: 건수·내용 동일(멱등)', async () => {
    const before = [await counts(pool), await contentHash(pool)];
    const reset = await runSeed(options(url, 'full-3', PHASE1, { reset: true }), {
      pool,
      db,
      steps: STAGE3_STEPS,
      log: () => {},
    });
    expect(reset.ok).toBe(true);
    expect(new Set(Object.values(stepStatus(reset)))).toEqual(new Set(['SUCCESS']));
    expect([await counts(pool), await contentHash(pool)]).toEqual(before);
  });

  it('R7: 코드구분명이 2개 이상이면 CODE step 실패·롤백(코드구분 0행)', async () => {
    await runSeed(options(url, 'r7-0', ['TEMPLATE'], { reset: true }), {
      pool,
      db,
      steps: STAGE3_STEPS,
      log: () => {},
    });
    await runSeed(options(url, 'r7-1', ['BIZ_AREA']), {
      pool,
      db,
      steps: STAGE3_STEPS,
      log: () => {},
    });
    await pool.query(
      "update legacy.tb_code_info set code_cls_nm = '다른이름' where ctid = (select ctid from legacy.tb_code_info where biz_cls = 'RP' and code_cls = '010' limit 1)",
    );
    try {
      const r = await runSeed(options(url, 'r7-3', ['CODE']), {
        pool,
        db,
        steps: STAGE3_STEPS,
        log: () => {},
      });
      expect(r.ok).toBe(false);
      expect(r.steps[0]).toMatchObject({ step: 'CODE', status: 'FAILED' });
      expect(r.steps[0]!.message).toContain('RP.010');
      expect((await counts(pool)).code_cls).toBe(0);
    } finally {
      await pool.query(
        "update legacy.tb_code_info set code_cls_nm = '연구분류' where biz_cls = 'RP' and code_cls = '010'",
      );
    }
  });

  it('RECONCILE 불일치 → FAILED(종료 코드 1)', async () => {
    const r0 = await runSeed(
      options(
        url,
        'rc-0',
        PHASE1.filter((s) => s !== 'LOAD_LEGACY'),
        { reset: true },
      ),
      { pool, db, steps: STAGE3_STEPS, log: () => {} },
    );
    expect(r0.ok).toBe(true);
    await pool.query("delete from std_term where term_kor = '연구'");
    const r = await runSeed(options(url, 'rc-1', ['RECONCILE']), {
      pool,
      db,
      steps: STAGE3_STEPS,
      log: () => {},
    });
    expect(r.ok).toBe(false);
    expect(r.steps[0]).toMatchObject({ step: 'RECONCILE', status: 'FAILED' });
    expect(csvRows(r, 'reconcile').find((l) => l.startsWith('용어,'))).toContain('MISMATCH');
  });
});
