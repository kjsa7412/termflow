import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, MigrationIntegrityError, runMigrations } from '../../src/db/migrate.js';
import { resetDatabase } from '../../src/db/reset.js';
import { createDatabase } from './setup/databases.js';

const EXPECTED_TABLES = [
  'ddl_export_log',
  'migration_log',
  'prj_biz_area',
  'prj_column',
  'prj_table',
  'prj_table_history',
  'project_copy_log',
  'std_audit_log',
  'std_code',
  'std_code_cls',
  'std_default_col',
  'std_default_col_set',
  'std_domain',
  'std_domain_cls',
  'std_term',
  'tf_project',
  'tf_project_member',
  'tf_session',
  'tf_user',
];

async function tables(pool: pg.Pool): Promise<string[]> {
  const { rows } = await pool.query<{ t: string }>(
    "select table_name as t from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1",
  );
  return rows.map((r) => r.t);
}

async function historyCount(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    'select count(*) as n from drizzle.__drizzle_migrations',
  );
  return Number(rows[0]?.n);
}

/**
 * 폴더 복사. Node 22 `fs.cpSync`는 Windows 비ASCII 경로(사용자 폴더명이 한글)에서
 * 프로세스가 segfault로 죽으므로 쓰지 않는다(PoC 발견 제약).
 */
function copyDir(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else copyFileSync(s, d);
  }
}

/** 기존 마이그레이션 폴더를 복사하고 0002 파일을 덧붙인 임시 폴더를 만든다. */
function folderWith0002(name: string, body: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tf-mig-'));
  copyDir(MIGRATIONS_FOLDER, dir);
  const journalPath = path.join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
  };
  const last = journal.entries[journal.entries.length - 1]!;
  journal.entries.push({
    idx: last.idx + 1,
    version: last.version,
    when: last.when + 1000,
    tag: name,
    breakpoints: true,
  });
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  writeFileSync(path.join(dir, `${name}.sql`), body);
  return dir;
}

/** drizzle 0.45는 pg 오류를 DrizzleQueryError('Failed query: …')로 감싸고 원인을 `cause`에 둔다. */
async function failureCause(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return String((err as Error & { cause?: Error }).cause?.message);
}

describe('db/migrate (T1.2·T1.3 → T2.1)', () => {
  let pool: pg.Pool;
  const tmpDirs: string[] = [];

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createDatabase('t_migrate') });
  });
  afterAll(async () => {
    await pool.end();
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  it('T1.2 부록 A 적용 → 19 테이블 + 이력 1행, 재실행 시 변경 없음', async () => {
    const t0 = performance.now();
    await runMigrations(pool);
    console.log(`[db/migrate] baseline 적용 ${Math.round(performance.now() - t0)}ms`);
    expect(await tables(pool)).toEqual(EXPECTED_TABLES);
    expect(await historyCount(pool)).toBe(1);
    expect(await runMigrations(pool)).toEqual({ applied: 0, total: 1 });
    expect(await historyCount(pool)).toBe(1);
  });

  it('T2.1 적용된 파일이 바뀌거나 사라지면 MigrationIntegrityError(해시 대조), 동시 실행은 직렬화', async () => {
    const edited = folderWith0002('0002_noop', 'SELECT 1;');
    tmpDirs.push(edited);
    const baseline = path.join(edited, '0001_baseline.sql');
    writeFileSync(baseline, `${readFileSync(baseline, 'utf8')}-- 적용 후 수정`);
    await expect(runMigrations(pool, edited)).rejects.toBeInstanceOf(MigrationIntegrityError);
    expect(await historyCount(pool)).toBe(1); // 0002도 적용되지 않음

    const missing = mkdtempSync(path.join(os.tmpdir(), 'tf-mig-'));
    tmpDirs.push(missing);
    mkdirSync(path.join(missing, 'meta'));
    writeFileSync(
      path.join(missing, 'meta', '_journal.json'),
      JSON.stringify({ version: '7', dialect: 'postgresql', entries: [] }),
    );
    await expect(runMigrations(pool, missing)).rejects.toThrow(/파일이 없습니다/);

    const results = await Promise.all([
      runMigrations(pool),
      runMigrations(pool),
      runMigrations(pool),
    ]);
    expect(results).toEqual([
      { applied: 0, total: 1 },
      { applied: 0, total: 1 },
      { applied: 0, total: 1 },
    ]);
  });

  it('T1.2 복합 FK ON DELETE SET NULL(열)·DEFERRABLE 유니크·부분 인덱스가 카탈로그에 존재', async () => {
    const { rows: fks } = await pool.query<{ conname: string; def: string }>(
      `select conname, pg_get_constraintdef(oid) as def from pg_constraint
        where conname in ('fk_std_domain_cls','fk_prj_column_domain','fk_prj_column_code_cls',
                          'fk_prj_column_default_col','fk_tf_project_colset')
        order by conname`,
    );
    expect(fks).toHaveLength(5);
    for (const fk of fks) expect(fk.def).toMatch(/ON DELETE SET NULL \(\w+\)/);

    const { rows: defer } = await pool.query<{
      conname: string;
      condeferrable: boolean;
      condeferred: boolean;
    }>(
      "select conname, condeferrable, condeferred from pg_constraint where conname in ('uk_prj_column_seq','uk_prj_column_phys') order by 1",
    );
    expect(defer).toEqual([
      { conname: 'uk_prj_column_phys', condeferrable: true, condeferred: true },
      { conname: 'uk_prj_column_seq', condeferrable: true, condeferred: true },
    ]);

    const { rows: idx } = await pool.query<{ indexname: string; indexdef: string }>(
      "select indexname, indexdef from pg_indexes where indexname in ('ix_std_term_pending','ix_std_domain_review','ux_std_default_col_set_default') order by 1",
    );
    expect(idx).toHaveLength(3);
    for (const i of idx) expect(i.indexdef).toMatch(/ WHERE /);
  });

  it('T1.3① 오류 마이그레이션(여러 문장을 한 묶음으로)은 전체 롤백: 이력 미기록·부분 객체 없음', async () => {
    const dir = folderWith0002(
      '0002_poc_fail',
      'CREATE TABLE poc_partial (id int);\nINSERT INTO poc_partial VALUES (1);\nSELECT 1/0;\n',
    );
    tmpDirs.push(dir);
    expect(await failureCause(runMigrations(pool, dir))).toMatch(/division by zero/);
    expect(await historyCount(pool)).toBe(1);
    expect(await tables(pool)).not.toContain('poc_partial');
  });

  it('T1.3① 오류 마이그레이션(breakpoint로 나눈 여러 문장)도 전체 롤백', async () => {
    const dir = folderWith0002(
      '0002_poc_fail_bp',
      [
        'CREATE TABLE poc_partial_bp (id int);',
        '--> statement-breakpoint',
        'ALTER TABLE tf_user ADD COLUMN poc_col int;',
        '--> statement-breakpoint',
        'SELECT 1/0;',
        '',
      ].join('\n'),
    );
    tmpDirs.push(dir);
    expect(await failureCause(runMigrations(pool, dir))).toMatch(/division by zero/);
    expect(await historyCount(pool)).toBe(1);
    expect(await tables(pool)).not.toContain('poc_partial_bp');
    const { rows } = await pool.query(
      "select 1 from information_schema.columns where table_name='tf_user' and column_name='poc_col'",
    );
    expect(rows).toHaveLength(0);
  });

  it('T1.3② db:reset은 데이터·이력을 지우고 baseline을 다시 적용, production은 거부', async () => {
    await pool.query(
      "insert into tf_user(login_id,user_nm,password_hash,created_by,updated_by) values('u1','사용자1','x','SYSTEM','SYSTEM')",
    );
    await expect(resetDatabase(pool, 'production')).rejects.toThrow(/production/);
    await resetDatabase(pool, 'development');
    expect(await tables(pool)).toEqual(EXPECTED_TABLES);
    expect(await historyCount(pool)).toBe(1);
    const { rows } = await pool.query<{ n: string }>('select count(*) as n from tf_user');
    expect(Number(rows[0]?.n)).toBe(0);
  });
});
