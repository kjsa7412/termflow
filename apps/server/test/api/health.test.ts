import type { INestApplication } from '@nestjs/common';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { HEALTH_STATUS } from '@termflow/shared';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { PG_POOL } from '../../src/db/db.module.js';
import { HealthModule } from '../../src/health/health.module.js';

// T2.3 /health DB 포함 — 컨테이너 없이 풀을 대체해 up/down 판정만 본다(실 DB는 test/db/health.test.ts).
async function appWith(query: () => Promise<unknown>): Promise<INestApplication> {
  @Global()
  @Module({ providers: [{ provide: PG_POOL, useValue: { query } }], exports: [PG_POOL] })
  class FakeDbModule {}
  const moduleRef = await Test.createTestingModule({
    imports: [FakeDbModule, HealthModule],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

describe('GET /health', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
  });

  it('DB가 응답하면 200과 status ok, info.db up', async () => {
    app = await appWith(async () => ({ rows: [{ '?column?': 1 }] }));
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    const body = res.body as { status: string; info: { db: { status: string } } };
    expect(body.status).toBe(HEALTH_STATUS.OK);
    expect(body.info.db.status).toBe('up');
  });

  it('DB 오류면 503과 error.db down', async () => {
    app = await appWith(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:5434');
    });
    const res = await request(app.getHttpServer()).get('/health').expect(503);
    const body = res.body as { status: string; error: { db: { status: string; message: string } } };
    expect(body.status).toBe(HEALTH_STATUS.ERROR);
    expect(body.error.db).toMatchObject({ status: 'down' });
    expect(body.error.db.message).toMatch(/ECONNREFUSED/);
  });
});
