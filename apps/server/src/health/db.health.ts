import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import pg from 'pg';
import { PG_POOL } from '../db/db.module.js';

/** `/health`의 DB 항목(T2.3): `select 1`이 제한 시간 안에 끝나면 up, 아니면 down → 503. */
@Injectable()
export class DbHealthIndicator {
  static readonly TIMEOUT_MS = 3_000;

  constructor(
    private readonly indicators: HealthIndicatorService,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
  ) {}

  async check() {
    const session = this.indicators.check('db');
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.pool.query('select 1'),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timeout ${DbHealthIndicator.TIMEOUT_MS}ms`)),
            DbHealthIndicator.TIMEOUT_MS,
          );
        }),
      ]);
      return session.up();
    } catch (e) {
      return session.down({ message: e instanceof Error ? e.message : String(e) });
    } finally {
      clearTimeout(timer);
    }
  }
}
