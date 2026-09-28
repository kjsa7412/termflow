import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

/**
 * LOAD_LEGACY(설계서 §11.1 step 1, T3.3). 원본 dump(`seed/original/dump-gen_table-new.sql`, 수정 금지)를
 * 치환해 `legacy` 스키마에 원본 그대로 적재한다. 채택 방식은 PoC T1.9 ② pg 드라이버 단순 질의 1회.
 *
 * 치환 규칙 4개(PoC T1.9):
 *  1. DB 수준 블록(`DROP DATABASE` ~ `\connect`) 제거
 *  2. `CREATE SCHEMA public` → `CREATE SCHEMA legacy`, `COMMENT ON SCHEMA public` 제거
 *  3. `ALTER … OWNER TO …;` 제거(원본 롤 없음)
 *  4. `public.` → `legacy.`(데이터 값에는 0건 — 치환 전 검사)
 */
export const LEGACY_SCHEMA = 'legacy';

/** legacy 원본 테이블(§11.4 원본 열). 미사용 이력 테이블(R12, 0건)은 적재만 되고 쓰지 않는다. */
export const LEGACY_TABLES = [
  'tb_term_dict',
  'tb_domain_cls',
  'tb_domain',
  'tb_code_info',
  'tb_default_col',
  'tb_table_schema',
  'tb_column_schema',
] as const;
export type LegacyTable = (typeof LEGACY_TABLES)[number];

export class LegacyTransformError extends Error {
  override name = 'LegacyTransformError';
}

/** dump 문자열 → legacy 치환본. 규칙이 기대대로 적용되지 않으면 예외(조용한 오적재 방지). */
export function transformDump(dump: string): string {
  const text = dump.replace(/\r\n/g, '\n');
  const lines = text.split('\n');

  // 1. DB 수준 블록 제거
  const dropIdx = lines.findIndex((l) => /^DROP DATABASE\b/.test(l));
  const connectIdx = lines.findIndex((l) => /^\\connect\b/.test(l));
  if (dropIdx < 0 || connectIdx < dropIdx) {
    throw new LegacyTransformError('DB 수준 블록(DROP DATABASE ~ \\connect)을 찾지 못했습니다');
  }
  const body = [...lines.slice(0, dropIdx), ...lines.slice(connectIdx + 1)];

  // 데이터 값 안의 `public.` 검사(INSERT 문 중 `INSERT INTO public.x VALUES` 접두 뒤)
  for (const l of body) {
    if (l.startsWith('INSERT INTO public.')) {
      const values = l.slice(l.indexOf(' VALUES '));
      if (values.includes('public.')) {
        throw new LegacyTransformError('데이터 값에 "public." 문자열이 있어 단순 치환할 수 없습니다');
      }
    }
  }

  const out: string[] = [];
  let createSchema = 0;
  for (let i = 0; i < body.length; i++) {
    const l = body[i]!;
    // 2. 스키마 생성·주석
    if (l === 'CREATE SCHEMA public;') {
      out.push(`CREATE SCHEMA ${LEGACY_SCHEMA};`);
      createSchema++;
      continue;
    }
    if (/^COMMENT ON SCHEMA public\b/.test(l)) continue;
    // 3. OWNER TO(한 줄 또는 `ALTER TABLE ONLY x` 다음 줄에 이어지는 형태 모두 한 줄로 끝남)
    if (/^ALTER .* OWNER TO .*;$/.test(l)) continue;
    // 4. 스키마 한정 치환
    out.push(l.replaceAll('public.', `${LEGACY_SCHEMA}.`));
  }
  if (createSchema !== 1) {
    throw new LegacyTransformError(`CREATE SCHEMA public 문이 ${createSchema}개입니다(1개 기대)`);
  }
  const result = out.join('\n');
  if (/\bpublic\./.test(result.replace(/'(?:[^']|'')*'/g, "''"))) {
    throw new LegacyTransformError('치환 후에도 SQL에 public. 한정자가 남았습니다');
  }
  return result;
}

export interface LegacyLoadResult {
  counts: Record<LegacyTable, number>;
  workFile: string;
}

/** legacy 스키마 존재 여부(tb_term_dict 기준). */
export async function legacyExists(pool: pg.Pool): Promise<boolean> {
  const { rows } = await pool.query<{ t: string | null }>(
    `select to_regclass('${LEGACY_SCHEMA}.tb_term_dict')::text as t`,
  );
  return Boolean(rows[0]?.t);
}

export async function legacyCounts(
  q: Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>,
): Promise<Record<LegacyTable, number>> {
  const sqlText = LEGACY_TABLES.map(
    (t) => `select '${t}' as t, count(*)::int as n from ${LEGACY_SCHEMA}.${t}`,
  ).join(' union all ');
  const { rows } = await q.query<{ t: LegacyTable; n: number }>(sqlText);
  return Object.fromEntries(rows.map((r) => [r.t, r.n])) as Record<LegacyTable, number>;
}

/** 스키마 legacy 제거(dev `--reset`에서 LOAD_LEGACY를 다시 돌릴 때). */
export async function dropLegacy(pool: pg.Pool): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS ${LEGACY_SCHEMA} CASCADE`);
}

/**
 * 치환본을 작업 파일(`migration/work/dump-legacy.sql`, gitignore)로 쓰고 **전용 연결**로 1회 실행한다.
 * dump의 `set_config('search_path','')`가 세션에 남으므로 풀 연결을 쓰지 않고 실행 후 닫는다(PoC T1.9).
 * `BEGIN … COMMIT` 한 트랜잭션: 실패하면 스키마 legacy도 남지 않는다.
 */
export async function loadLegacy(
  connection: pg.ClientConfig,
  dumpPath: string,
  workDir: string,
): Promise<LegacyLoadResult> {
  const transformed = transformDump(readFileSync(dumpPath, 'utf8'));
  mkdirSync(workDir, { recursive: true });
  const workFile = path.join(workDir, 'dump-legacy.sql');
  writeFileSync(workFile, transformed, 'utf8');

  const client = new pg.Client(connection);
  await client.connect();
  try {
    try {
      await client.query(`BEGIN;\n${transformed}\nCOMMIT;`);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    }
    // search_path가 비워진 세션이므로 스키마 한정 질의만 쓴다.
    const counts = await legacyCounts(client);
    return { counts, workFile };
  } finally {
    await client.end();
  }
}
