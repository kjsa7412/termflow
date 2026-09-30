import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../../../src/db/migrate.js';

/**
 * pnpm test:db 전역 준비(T1.1 → T2.12, §2.5.7): postgres:17 컨테이너 1개 + 마이그레이션 1회.
 * 마이그레이션을 적용한 템플릿 DB(`tf_template`)를 만들어 두고, 테스트 파일은
 * `CREATE DATABASE … TEMPLATE tf_template`으로 격리된 DB를 복제한다(파일당 수십 ms).
 *
 * 기동 시간 단축(CR-10 C2):
 * - 기동 시간의 대부분은 initdb의 "syncing data to disk"(약 10초)와 초기화 임시 서버 종료 checkpoint의 fsync(약 5초)였다.
 *   Docker Desktop(WSL2) 디스크 fsync가 느리고, 다른 컨테이너·테스트가 디스크를 쓰는 중에는 수십 배로 늘어난다(최대 약 130초).
 *   테스트 DB는 버리는 데이터이므로 `initdb --no-sync` + `fsync=off`·`synchronous_commit=off`·`full_page_writes=off`로 끈다.
 * - 재사용(기본): 컨테이너를 테스트 뒤에도 남겨 두고 다음 실행이 그대로 쓴다(testcontainers reuse, Ryuk 없음).
 *   실행마다 이전 테스트 DB를 지우고 템플릿을 새 마이그레이션으로 다시 만든다.
 *   `TF_TEST_DB_REUSE=0`이면 실행마다 새 컨테이너(종료 시 삭제) — test:db를 **동시에 두 개** 돌릴 때(예: bench와 test:db)는 이 값을 쓴다.
 *   남은 컨테이너 정리: `docker rm -f termflow-test-db`.
 */
declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
    pgContainerId: string;
    pgStartMs: number;
    pgTemplateDb: string;
  }
}

export const TEMPLATE_DB = 'tf_template';
export const REUSE = process.env['TF_TEST_DB_REUSE'] !== '0';
export const REUSE_NAME = 'termflow-test-db';

/** 컨테이너 안 관리 DB(termflow)와 시스템 DB를 뺀 나머지 = 이전 실행이 남긴 테스트 DB. */
const KEEP_DBS = ['postgres', 'termflow', 'template0', 'template1'];

let container: StartedPostgreSqlContainer | undefined;

function build(): PostgreSqlContainer {
  const c = new PostgreSqlContainer('postgres:17')
    .withDatabase('termflow')
    .withUsername('termflow')
    .withPassword('termflow')
    .withEnvironment({ TZ: 'Asia/Seoul', POSTGRES_INITDB_ARGS: '--no-sync' })
    .withCommand([
      'postgres',
      '-c',
      'fsync=off',
      '-c',
      'synchronous_commit=off',
      '-c',
      'full_page_writes=off',
    ]);
  return REUSE ? c.withReuse().withName(REUSE_NAME) : c;
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const t0 = performance.now();
  container = await build().start();
  const startMs = Math.round(performance.now() - t0);
  const adminUrl = container.getConnectionUri();

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const { rows } = await admin.query<{ datname: string }>(
    'select datname from pg_database where not (datname = any($1))',
    [KEEP_DBS],
  );
  for (const { datname } of rows) {
    if (!/^[a-z][a-z0-9_]*$/.test(datname)) continue;
    await admin.query(`ALTER DATABASE ${datname} IS_TEMPLATE false`);
    await admin.query(`DROP DATABASE ${datname} WITH (FORCE)`);
  }
  await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${TEMPLATE_DB}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
  await runMigrations(pool);
  await pool.end(); // 템플릿에 연결이 남아 있으면 복제가 실패한다

  console.log(
    `[test:db] postgres:17 컨테이너 ${REUSE ? '재사용 모드' : '새로'} 준비 ${startMs}ms + 이전 DB ${rows.length}개 정리·템플릿 마이그레이션 ${Math.round(performance.now() - t0 - startMs)}ms (${container.getId().slice(0, 12)})`,
  );
  project.provide('pgAdminUrl', adminUrl);
  project.provide('pgContainerId', container.getId());
  project.provide('pgStartMs', startMs);
  project.provide('pgTemplateDb', TEMPLATE_DB);

  return async () => {
    if (REUSE) return; // 다음 실행이 쓴다(테스트 DB는 다음 실행 준비에서 지운다)
    const t1 = performance.now();
    await container?.stop();
    console.log(`[test:db] 컨테이너 정리 ${Math.round(performance.now() - t1)}ms`);
  };
}
