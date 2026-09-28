import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import { clsOptions } from './common/audit/audit-context.js';
import { CommonModule } from './common/common.module.js';
import { loggerParams } from './common/logging/logger.config.js';
import { ProblemDetailFilter } from './common/problem/problem-detail.filter.js';
import { AppConfigModule } from './config/config.module.js';
import type { Env } from './config/env.schema.js';
import { DbModule } from './db/db.module.js';
import { HealthModule } from './health/health.module.js';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        loggerParams({
          NODE_ENV: config.get('NODE_ENV', { infer: true }),
          LOG_LEVEL: config.get('LOG_LEVEL', { infer: true }),
        }),
    }),
    ClsModule.forRoot(clsOptions),
    CommonModule,
    DbModule,
    HealthModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: ProblemDetailFilter }],
})
export class AppModule {}
