/**
 * PostgreSQL 예약어 목록 생성(T7.4, 설계서 §6.9). 실행 중인 PostgreSQL(기본: `.env`의 dev DB = postgres:17 컨테이너)의
 * `pg_get_keywords()`에서 catcode R(예약)·T(예약, 함수·타입명으로만 허용) 단어를 읽어
 * `resources/ddl/reserved/postgresql.txt`를 다시 쓴다. 파일 주석에 출처·서버 버전을 남긴다.
 *
 *   pnpm --filter @termflow/server ddl:reserved
 *
 * catcode U(비예약)·C(컬럼명 가능)는 비인용 식별자로 쓸 수 있으므로 제외한다.
 * `test:db -- ddl-regression`이 컨테이너의 현재 목록과 파일이 같은지 검사한다(버전 상향 시 갱신 누락 방지).
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvOrExit } from '../src/config/load-env.js';
import { createPool } from '../src/db/client.js';
import { renderReservedFile, RESERVED_KEYWORDS_SQL } from '../src/ddl/reserved-words.js';

async function main(): Promise<void> {
  const env = loadEnvOrExit();
  const pool = createPool({ ...env, DB_POOL_MAX: 1 });
  try {
    const { rows: v } = await pool.query<{ server_version: string }>('show server_version');
    const { rows } = await pool.query<{ word: string }>(RESERVED_KEYWORDS_SQL);
    const version = v[0]?.server_version ?? '?';
    const out = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../resources/ddl/reserved/postgresql.txt',
    );
    writeFileSync(
      out,
      renderReservedFile(
        version,
        rows.map((r) => r.word),
      ),
      'utf8',
    );
    console.log(`[ddl:reserved] PostgreSQL ${version} 예약어 ${rows.length}개 → ${out}`);
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(`[ddl:reserved] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
