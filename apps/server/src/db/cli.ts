/**
 * DB 명령(개발·운영 공용): `pnpm db:migrate`, `pnpm db:reset`(dev 전용).
 * 실행: `tsx src/db/cli.ts <migrate|reset>` 또는 빌드 후 `node dist/db/cli.js <migrate|reset>`.
 */
import { loadEnvOrExit } from '../config/load-env.js';
import { createPool } from './client.js';
import { runMigrations } from './migrate.js';
import { resetDatabase } from './reset.js';

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== 'migrate' && command !== 'reset') {
    console.error('사용법: cli.ts <migrate|reset>');
    process.exit(2);
  }
  const env = loadEnvOrExit();
  const pool = createPool(env);
  try {
    if (command === 'migrate') {
      const r = await runMigrations(pool);
      console.log(`[db:migrate] 적용 ${r.applied}건, 전체 ${r.total}건`);
    } else {
      const r = await resetDatabase(pool, env.NODE_ENV);
      console.log(`[db:reset] 스키마 초기화 후 재적용 ${r.total}건`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exit(1);
});
