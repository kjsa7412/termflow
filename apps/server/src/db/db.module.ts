import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import pg from 'pg';
import type { Env } from '../config/env.schema.js';
import { createDb, createPool } from './client.js';

/** 주입 토큰: pg.Pool / Drizzle 인스턴스(Db). */
export const PG_POOL = Symbol('PG_POOL');
export const DRIZZLE = Symbol('DRIZZLE');

/**
 * DB 모듈(T2.3). 풀 1개(`DB_POOL_MAX`, 세션 timezone=Asia/Seoul)와 Drizzle 인스턴스를 전역 제공한다.
 * 마이그레이션은 main.ts가 Nest 기동 전에 끝낸다(실패 시 기동 실패, T2.1).
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        createPool({
          TERMFLOW_DB_URL: config.get('TERMFLOW_DB_URL', { infer: true }),
          TERMFLOW_DB_USER: config.get('TERMFLOW_DB_USER', { infer: true }),
          TERMFLOW_DB_PASSWORD: config.get('TERMFLOW_DB_PASSWORD', { infer: true }),
          DB_POOL_MAX: config.get('DB_POOL_MAX', { infer: true }),
        }),
    },
    { provide: DRIZZLE, inject: [PG_POOL], useFactory: (pool: pg.Pool) => createDb(pool) },
  ],
  exports: [PG_POOL, DRIZZLE],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
