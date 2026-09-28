import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

/**
 * pnpm test:db 전역 준비(T1.1, §2.5.7): postgres:17 컨테이너 1개를 기동하고
 * 접속 정보를 테스트 파일에 provide한다. 테스트 파일은 이 컨테이너 안에 자기 DB를 만든다.
 */
declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
    pgContainerId: string;
    pgStartMs: number;
  }
}

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
  console.log(
    `[test:db] postgres:17 컨테이너 기동 ${startMs}ms (${container.getId().slice(0, 12)})`,
  );

  project.provide('pgAdminUrl', container.getConnectionUri());
  project.provide('pgContainerId', container.getId());
  project.provide('pgStartMs', startMs);

  return async () => {
    const t1 = performance.now();
    await container?.stop();
    console.log(`[test:db] 컨테이너 정리 ${Math.round(performance.now() - t1)}ms`);
  };
}
