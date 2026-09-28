import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Env } from '../config/env.schema.js';
import * as relations from './relations.js';
import * as schema from './schema.js';

/** DB 세션 시간대(설계서 §2.8: 컨테이너·런타임 TZ=Asia/Seoul, DB timezone='Asia/Seoul'). */
export const DB_TIMEZONE = 'Asia/Seoul';

type DbEnv = Pick<
  Env,
  'TERMFLOW_DB_URL' | 'TERMFLOW_DB_USER' | 'TERMFLOW_DB_PASSWORD' | 'DB_POOL_MAX'
>;

/**
 * pg 접속 설정. URL에는 호스트·포트·DB만 두고 계정은 별도 변수(§2.8)에서 채운다.
 * 세션마다 `timezone`을 지정해 서버 기본값과 무관하게 TIMESTAMP(0) 해석을 고정한다.
 */
export function poolConfig(env: DbEnv): pg.PoolConfig {
  // connectionString을 넘기면 pg가 URL 파싱 결과(계정 없음 → undefined)로 user/password를 덮어쓴다.
  // 그래서 URL을 직접 풀어 host·port·database만 쓴다.
  const url = new URL(env.TERMFLOW_DB_URL);
  return {
    host: decodeURIComponent(url.hostname),
    port: url.port ? Number(url.port) : 5432,
    database: decodeURIComponent(url.pathname.replace(/^\//, '')) || 'termflow',
    user: env.TERMFLOW_DB_USER,
    password: env.TERMFLOW_DB_PASSWORD,
    max: env.DB_POOL_MAX,
    options: `-c timezone=${DB_TIMEZONE}`,
    application_name: 'termflow',
    connectionTimeoutMillis: 5_000,
  };
}

export function createPool(env: DbEnv): pg.Pool {
  return new pg.Pool(poolConfig(env));
}

/** drizzle-kit(pull) 등 URL 하나만 받는 도구용: 계정을 URL에 넣는다. */
export function dbUrlWithAuth(env: Omit<DbEnv, 'DB_POOL_MAX'>): string {
  const url = new URL(env.TERMFLOW_DB_URL);
  url.username = encodeURIComponent(env.TERMFLOW_DB_USER);
  url.password = encodeURIComponent(env.TERMFLOW_DB_PASSWORD);
  return url.toString();
}

export const fullSchema = { ...schema, ...relations };
export type Db = NodePgDatabase<typeof fullSchema>;

/** Drizzle 인스턴스(§12.5: `casing: 'snake_case'`). */
export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema: fullSchema, casing: 'snake_case' });
}
