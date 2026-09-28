import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { createDatabase } from '../setup/databases.js';

// T1.9 legacy 적재 스파이크(§11.1): dump의 public. → legacy. 치환본을 ① psql 표준입력 ② pg 드라이버로 적재
// 원본(seed/original)은 읽기만 하고, 치환본은 gitignore 경로 migration/work/에 쓴다.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../..');
const DUMP = path.join(repoRoot, 'seed', 'original', 'dump-gen_table-new.sql');
const WORK = path.join(repoRoot, 'migration', 'work');

/**
 * 치환 규칙(PoC 확정, T3.3 LOAD_LEGACY가 같은 규칙을 쓴다):
 *  1. DB 수준 블록 제거: `DROP DATABASE` ~ `\connect gen_table`(대상 DB에 그대로 적재)
 *  2. `CREATE SCHEMA public;` → `CREATE SCHEMA legacy;`, `COMMENT ON SCHEMA public` 제거
 *  3. `ALTER … OWNER TO …;` 제거(원본 롤 postgres·gen_table은 대상에 없다)
 *  4. 나머지 `public.` → `legacy.` (dump에서 `public.`은 식별자 한정에만 쓰인다 — 데이터 값에는 0건)
 */
export function buildLegacyScript(dump: string): string {
  const lines = dump.split(/\r?\n/);
  const out: string[] = [];
  let skippingDb = false;
  for (const line of lines) {
    if (/^DROP DATABASE /.test(line)) skippingDb = true;
    if (skippingDb) {
      if (/^\\connect /.test(line)) skippingDb = false;
      continue;
    }
    if (/^CREATE SCHEMA public;$/.test(line)) {
      out.push('CREATE SCHEMA legacy;');
      continue;
    }
    if (/^COMMENT ON SCHEMA public /.test(line)) continue;
    if (/^ALTER .* OWNER TO [\w"]+;$/.test(line)) continue;
    out.push(line.replace(/\bpublic\./g, 'legacy.'));
  }
  const script = out.join('\n');
  if (/\\connect|\bpublic\./.test(script)) throw new Error('치환 누락');
  return script;
}

const EXPECTED: Record<string, number> = {
  tb_term_dict: 1705,
  tb_domain_cls: 54,
  tb_domain: 4587,
  tb_code_info: 991,
  tb_default_col: 9,
  tb_table_schema: 33,
  tb_column_schema: 649,
};

async function counts(url: string): Promise<Record<string, number>> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const r: Record<string, number> = {};
  for (const t of Object.keys(EXPECTED)) {
    const { rows } = await c.query<{ n: string }>(`select count(*) n from legacy.${t}`);
    r[t] = Number(rows[0]?.n);
  }
  await c.end();
  return r;
}

describe('poc/legacy-load (T1.9)', () => {
  let script: string;
  beforeAll(() => {
    const dump = readFileSync(DUMP, 'utf8');
    expect(/^COPY /m.test(dump)).toBe(false); // COPY 없이 INSERT만 사용
    script = buildLegacyScript(dump);
    mkdirSync(WORK, { recursive: true });
    writeFileSync(path.join(WORK, 'dump-legacy.sql'), script);
  });

  it('① psql 표준입력(docker exec -i … psql, compose exec -T와 같은 방식)', async () => {
    const url = await createDatabase('poc_legacy_psql');
    const t0 = performance.now();
    const res = spawnSync(
      'docker',
      [
        'exec',
        '-i',
        inject('pgContainerId'),
        'psql',
        '-U',
        'termflow',
        '-d',
        'poc_legacy_psql',
        '-v',
        'ON_ERROR_STOP=1',
        '-q',
        '-1', // 단일 트랜잭션
      ],
      { input: Buffer.from(script, 'utf8'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    const ms = Math.round(performance.now() - t0);
    if (res.status !== 0) console.error(res.stderr);
    expect(res.status).toBe(0);
    const c = await counts(url);
    console.log(`[poc/legacy] ① psql 적재 ${ms}ms ${JSON.stringify(c)}`);
    expect(c).toEqual(EXPECTED);
  });

  it('② pg 드라이버(단순 질의 1회, 전용 연결) — 앱 이미지에 psql 불필요', async () => {
    const url = await createDatabase('poc_legacy_pg');
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    const t0 = performance.now();
    await client.query(`BEGIN;\n${script}\nCOMMIT;`);
    const ms = Math.round(performance.now() - t0);
    // dump의 set_config('search_path','')가 세션에 남는다 → 풀 연결을 쓰면 오염되므로 전용 연결 후 종료
    const sp = await client.query<{ sp: string }>("select current_setting('search_path') sp");
    expect(sp.rows[0]?.sp).toBe('');
    await client.end();
    const c = await counts(url);
    console.log(`[poc/legacy] ② pg 드라이버 적재 ${ms}ms ${JSON.stringify(c)}`);
    expect(c).toEqual(EXPECTED);
  });

  it('② 실패 시 전체 롤백(부분 적재 없음)', async () => {
    const url = await createDatabase('poc_legacy_fail');
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    const broken = script.replace(
      /^INSERT INTO legacy\.tb_column_schema /m,
      'INSERT INTO legacy.nope ',
    );
    await expect(client.query(`BEGIN;\n${broken}\nCOMMIT;`)).rejects.toThrow(/legacy\.nope/);
    await client.end();
    const check = new pg.Client({ connectionString: url });
    await check.connect();
    const r = await check.query("select 1 from pg_namespace where nspname='legacy'");
    await check.end();
    expect(r.rows).toHaveLength(0);
  });
});
