import type pg from 'pg';
import { runMigrations } from './migrate.js';

/**
 * dev 초기화(`db:reset`): public·drizzle 스키마를 지우고 마이그레이션을 처음부터 다시 적용한다.
 * 운영(production)에서는 거부한다 — 운영 원칙은 "전진 전용 + 복구는 백업"(T1.3).
 */
export async function resetDatabase(
  pool: pg.Pool,
  nodeEnv: string,
  migrationsFolder?: string,
): Promise<void> {
  if (nodeEnv === 'production') {
    throw new Error('db:reset은 production에서 실행할 수 없습니다(전진 전용 + 백업 복구 원칙)');
  }
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await runMigrations(pool, migrationsFolder);
}
