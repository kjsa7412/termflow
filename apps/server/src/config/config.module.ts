import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './env.schema.js';

/**
 * `.env` 적재·검증은 main.ts(loadEnvOrExit)가 먼저 끝낸다.
 * 여기서는 검증된 값(기본값 포함)을 ConfigService로 노출만 한다.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      cache: true,
      validate: validateEnv,
    }),
  ],
})
export class AppConfigModule {}
