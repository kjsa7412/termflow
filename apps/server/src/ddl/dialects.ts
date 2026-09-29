import type { Dialect } from '@termflow/shared';
import type { DdlDialect } from './dialect.js';
import { PostgresDialect } from './postgres.dialect.js';

/**
 * 방언 레지스트리(D2: MVP는 PostgreSQL만 구현). Oracle·MySQL은 매핑 YAML·예약어 파일만 데이터로 두고,
 * 구현(`oracle.dialect.ts`·`mysql.dialect.ts`)은 2차 — 요청하면 UnsupportedDialectError(서비스가 422 `E_DIALECT_UNSUPPORTED`).
 * DDL 엔진은 DB·Nest에 의존하지 않는 순수 모듈이다(§2.3 Engine 계층).
 */
export const IMPLEMENTED_DIALECTS: readonly Dialect[] = ['POSTGRESQL'];

export class UnsupportedDialectError extends Error {
  override name = 'UnsupportedDialectError';
  constructor(readonly dialect: Dialect) {
    super(`지원하지 않는 방언: ${dialect}`);
  }
}

let postgres: PostgresDialect | undefined;

export function dialectFor(d: Dialect): DdlDialect {
  if (d === 'POSTGRESQL') return (postgres ??= new PostgresDialect());
  throw new UnsupportedDialectError(d);
}
