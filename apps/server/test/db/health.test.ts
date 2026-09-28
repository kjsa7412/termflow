import { Global, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PG_POOL } from '../../src/db/db.module.js';
import { HealthModule } from '../../src/health/health.module.js';
import { createMigratedDatabase } from './setup/databases.js';

// T2.3 DoD: DB 중지 시 /health 503, 재기동 후 200.
// 컨테이너를 멈추는 대신 대상 DB의 접속을 막고(ALLOW_CONNECTIONS false + 세션 종료) 다시 연다.
describe('/health — 실 DB (T2.3)', () => {
  let app: INestApplication;
  let pool: pg.Pool;
  let admin: pg.Client;
  const idleErrors: string[] = [];

  beforeAll(async () => {
    const url = await createMigratedDatabase('t_health');
    pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 2_000 });
    pool.on('error', (e) => idleErrors.push(e.message)); // createPool과 같은 처리(없으면 프로세스가 죽는다)
    admin = new pg.Client({ connectionString: inject('pgAdminUrl') });
    await admin.connect();

    @Global()
    @Module({ providers: [{ provide: PG_POOL, useValue: pool }], exports: [PG_POOL] })
    class RealPoolModule {}
    const moduleRef = await Test.createTestingModule({
      imports: [RealPoolModule, HealthModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });
  afterAll(async () => {
    await admin.query('ALTER DATABASE t_health ALLOW_CONNECTIONS true');
    await app.close();
    await pool.end();
    await admin.end();
  });

  it('200 → DB 차단 503 → 복구 200', async () => {
    const server = app.getHttpServer();
    await request(server).get('/health').expect(200);

    await admin.query('ALTER DATABASE t_health ALLOW_CONNECTIONS false');
    await admin.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = 't_health' and pid <> pg_backend_pid()",
    );
    const down = await request(server).get('/health').expect(503);
    expect((down.body as { error: { db: { status: string } } }).error.db.status).toBe('down');

    await admin.query('ALTER DATABASE t_health ALLOW_CONNECTIONS true');
    const up = await request(server).get('/health').expect(200);
    expect((up.body as { info: { db: { status: string } } }).info.db.status).toBe('up');
  });
});
