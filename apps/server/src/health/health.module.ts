import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { DbHealthIndicator } from './db.health.js';
import { HealthController } from './health.controller.js';

/** PG_POOL은 전역 DbModule이 제공한다(테스트는 대체 provider로 주입). */
@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [DbHealthIndicator],
})
export class HealthModule {}
