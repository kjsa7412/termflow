import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';

/** `apps/server/drizzle` — src/db·dist/db 어디서 실행해도 같은 위치(§2.5.10). */
export const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle',
);

/** 동시 기동 시 마이그레이션 직렬화용 advisory lock 키(임의 고정값). */
const MIGRATION_LOCK_KEY = 7_418_209_001;

export class MigrationIntegrityError extends Error {
  override name = 'MigrationIntegrityError';
}

export interface MigrationReport {
  /** 이번 실행에서 적용한 파일 수. */
  applied: number;
  /** 적용 완료된 전체 파일 수. */
  total: number;
}

async function appliedRows(client: pg.PoolClient): Promise<{ hash: string; created_at: string }[]> {
  const exists = await client.query<{ t: string | null }>(
    "select to_regclass('drizzle.__drizzle_migrations')::text as t",
  );
  if (!exists.rows[0]?.t) return [];
  const { rows } = await client.query<{ hash: string; created_at: string }>(
    'select hash, created_at from drizzle.__drizzle_migrations order by created_at',
  );
  return rows;
}

/**
 * 적용된 이력과 파일을 대조한다(PoC T1.2 발견: drizzle migrator는 해시를 검증하지 않는다).
 * "SQL이 진실" 규약상 적용 후 파일 수정·삭제는 오류로 본다 → 새 번호 파일로 전진한다.
 */
function verifyIntegrity(
  applied: { hash: string; created_at: string }[],
  files: { hash: string; folderMillis: number }[],
): void {
  const byMillis = new Map(files.map((f) => [f.folderMillis, f.hash]));
  for (const row of applied) {
    const hash = byMillis.get(Number(row.created_at));
    if (hash === undefined) {
      throw new MigrationIntegrityError(
        `DB에 적용된 마이그레이션(created_at=${row.created_at})에 해당하는 파일이 없습니다`,
      );
    }
    if (hash !== row.hash) {
      throw new MigrationIntegrityError(
        `적용된 마이그레이션 파일이 변경되었습니다(created_at=${row.created_at}). 적용된 파일은 수정하지 말고 새 파일을 추가하십시오`,
      );
    }
  }
}

/**
 * 순수 SQL 마이그레이션 적용(§2.5.3, T2.1). drizzle migrator는 미적용 파일 전부를 한 트랜잭션에서 실행하고
 * `drizzle.__drizzle_migrations`에 기록한다(실패 시 전체 롤백, 이력 미기록 — PoC T1.3).
 * 전후로 advisory lock을 잡아 동시 기동을 직렬화하고, 적용 이력과 파일 해시를 대조한다.
 */
export async function runMigrations(
  pool: pg.Pool,
  migrationsFolder: string = MIGRATIONS_FOLDER,
): Promise<MigrationReport> {
  const files = readMigrationFiles({ migrationsFolder });
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      const before = await appliedRows(client);
      verifyIntegrity(before, files);
      await migrate(drizzle(client), { migrationsFolder });
      const after = await appliedRows(client);
      return { applied: after.length - before.length, total: after.length };
    } finally {
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
