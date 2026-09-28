import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../../../src/db/migrate.js';

/**
 * pnpm test:db 전역 준비(T1.1 → T2.12, §2.5.7): postgres:17 컨테이너 1개 + 마이그레이션 1회.
 * 마이그레이션을 적용한 템플릿 DB(`tf_template`)를 만들어 두고, 테스트 파일은
 * `CREATE DATABASE … TEMPLATE tf_template`으로 격리된 DB를 복제한다(파일당 수십 ms).
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

let container: StartedPostgreSqlContainer | undefined;

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const t0 = performance.now();
  container = await new PostgreSqlContainer('postgres:17')
    .withDatabase('termflow')
    .withUsername('termflow')
    .withPassword('termflow')
    .withEnvironment({ TZ: 'Asia/Seoul' })
    .start();
  const startMs = Math.round(performance.now() - t0);
  const adminUrl = container.getConnectionUri();

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${TEMPLATE_DB}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
  await runMigrations(pool);
  await pool.end(); // 템플릿에 연결이 남아 있으면 복제가 실패한다

  console.log(
    `[test:db] postgres:17 컨테이너 기동 ${startMs}ms + 템플릿 마이그레이션 ${Math.round(performance.now() - t0 - startMs)}ms (${container.getId().slice(0, 12)})`,
  );
  project.provide('pgAdminUrl', adminUrl);
  project.provide('pgContainerId', container.getId());
  project.provide('pgStartMs', startMs);
  project.provide('pgTemplateDb', TEMPLATE_DB);

  return async () => {
    const t1 = performance.now();
    await container?.stop();
    console.log(`[test:db] 컨테이너 정리 ${Math.round(performance.now() - t1)}ms`);
  };
}
