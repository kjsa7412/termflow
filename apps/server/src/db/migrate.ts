import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';

/** `apps/server/drizzle` — src/db·dist/db 어디서 실행해도 같은 위치(§2.5.10). */
export const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle',
);

/**
 * 순수 SQL 마이그레이션 적용(§2.5.3). drizzle migrator는 미적용 파일 전부를 한 트랜잭션에서 실행하고
 * `drizzle.__drizzle_migrations`에 기록한다(실패 시 전체 롤백, 이력 미기록).
 */
export async function runMigrations(
  pool: pg.Pool,
  migrationsFolder: string = MIGRATIONS_FOLDER,
): Promise<void> {
  await migrate(drizzle(pool), { migrationsFolder });
}
