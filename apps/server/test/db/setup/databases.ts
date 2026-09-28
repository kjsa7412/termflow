import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, inject } from 'vitest';
import { createDb, type Db } from '../../../src/db/client.js';

/** 컨테이너 관리 DB(termflow) 접속 URL에서 DB 이름만 바꾼다. */
export function dbUrl(database: string): string {
  const url = new URL(inject('pgAdminUrl'));
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * 테스트 파일마다 격리된 DB를 만든다(이미 있으면 지우고 다시 만든다).
 * `template`을 주면 그 DB를 복제한다 — 마이그레이션 적용본은 `inject('pgTemplateDb')`.
 */
export async function createDatabase(database: string, template?: string): Promise<string> {
  if (!/^[a-z][a-z0-9_]*$/.test(database)) throw new Error(`잘못된 DB 이름: ${database}`);
  const admin = new pg.Client({ connectionString: inject('pgAdminUrl') });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${database}${template ? ` TEMPLATE ${template}` : ''}`);
  } finally {
    await admin.end();
  }
  return dbUrl(database);
}

/** 마이그레이션(0001_baseline) 적용 상태의 새 DB. */
export function createMigratedDatabase(database: string): Promise<string> {
  return createDatabase(database, inject('pgTemplateDb'));
}

/** public 스키마의 모든 테이블을 비우고 IDENTITY를 되돌린다(테스트 간 격리). */
export async function truncateAll(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ t: string }>(
    "select format('%I', tablename) t from pg_tables where schemaname = 'public'",
  );
  if (rows.length === 0) return;
  await pool.query(`TRUNCATE ${rows.map((r) => r.t).join(', ')} RESTART IDENTITY CASCADE`);
}

const SEED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../seed');

/** test/seed/<name>.sql 적재(여러 문장 → 단순 질의 1회, 한 트랜잭션). */
export async function loadFixture(pool: pg.Pool, name: 'std_small'): Promise<void> {
  const sqlText = readFileSync(path.join(SEED_DIR, `${name}.sql`), 'utf8');
  await pool.query(`BEGIN;\n${sqlText}\nCOMMIT;`);
}

/** std_small 픽스처 사용자 비밀번호(테스트 전용 값). */
export const FIXTURE_PASSWORD = 'Test1234!';

export interface TestDb {
  pool: pg.Pool;
  db: Db;
  url: string;
}

/**
 * 파일 단위 DB 훅: beforeAll에서 템플릿 복제 → (옵션) 테스트마다 TRUNCATE + 픽스처 재적재 → afterAll에서 풀 종료.
 * 반환 객체의 필드는 beforeAll 이후에 채워진다.
 */
export function useTestDb(
  database: string,
  opts: { truncateEach?: boolean; fixture?: 'std_small' } = {},
): TestDb {
  const ctx = {} as TestDb;
  beforeAll(async () => {
    ctx.url = await createMigratedDatabase(database);
    ctx.pool = new pg.Pool({ connectionString: ctx.url, max: 4 });
    ctx.db = createDb(ctx.pool);
    if (opts.fixture && !opts.truncateEach) await loadFixture(ctx.pool, opts.fixture);
  });
  if (opts.truncateEach) {
    beforeEach(async () => {
      await truncateAll(ctx.pool);
      if (opts.fixture) await loadFixture(ctx.pool, opts.fixture);
    });
  }
  afterAll(async () => {
    await ctx.pool?.end();
  });
  return ctx;
}
