/**
 * `docs/cr09_rename_postgresql.sql` 생성(CR-09). 정정(TERM_UNIFY) 후의 DB에서 legacy 원본 이름 → R19 대응과 RMS 모델(제약 이름)을 읽어
 * 운영 DB 전환 스크립트를 쓴다. 입력이 같으면 같은 파일(생성 시각 없음) — `pnpm test:db -- term-unify`가 러너 결과와 문자열 비교한다.
 *
 *   pnpm --filter @termflow/server cr09:sql [-- --out=../../docs/cr09_rename_postgresql.sql]
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvOrExit } from '../src/config/load-env.js';
import { createDb, createPool } from '../src/db/client.js';
import {
  loadRmsRenamePairs,
  renameCounts,
  renderRenameSql,
} from '../src/migration/cr09-rename-sql.js';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function main(): Promise<void> {
  const env = loadEnvOrExit();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const out = path.resolve(here, '..', arg('out', '../../docs/cr09_rename_postgresql.sql'));
  const pool = createPool({ ...env, DB_POOL_MAX: 1 });
  try {
    const pairs = await loadRmsRenamePairs(createDb(pool));
    writeFileSync(out, renderRenameSql(pairs), 'utf8');
    console.log(`[cr09:sql] → ${out} ${JSON.stringify(renameCounts(pairs))}`);
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(`[cr09:sql] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
