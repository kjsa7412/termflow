import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { DbHealthIndicator } from './db.health.js';

/** `GET /health`(루트, `/api/v1` 밖) — DB 포함(T2.3). DB가 응답하지 않으면 503. */
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: DbHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([() => this.db.check()]);
  }
}
