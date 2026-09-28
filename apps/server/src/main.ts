import 'reflect-metadata';
import { API_PREFIX, APP_NAME } from '@termflow/shared';
import { loadEnvOrExit } from './config/load-env.js';

async function main(): Promise<void> {
  // 설계서 §2.8: 런타임 TZ=Asia/Seoul(컨테이너는 환경 변수로, 로컬 dev는 여기서 보정)
  process.env['TZ'] ??= 'Asia/Seoul';
  // 환경 변수 검증을 AppModule 평가보다 먼저 끝낸다(누락 시 여기서 종료 코드 1).
  const env = loadEnvOrExit();
  if (env.usedDevDefaults.length > 0) {
    console.warn(`[${APP_NAME}] 개발용 기본값 사용: ${env.usedDevDefaults.join(', ')}`);
  }

  // 스키마 마이그레이션을 Nest 기동 전에 적용한다. 실패하면 기동하지 않는다(§2.8, T2.1).
  const { createPool } = await import('./db/client.js');
  const { runMigrations } = await import('./db/migrate.js');
  const pool = createPool(env);
  try {
    const r = await runMigrations(pool);
    console.log(`[${APP_NAME}] 마이그레이션 적용 ${r.applied}건, 전체 ${r.total}건`);
  } finally {
    await pool.end();
  }

  const { NestFactory } = await import('@nestjs/core');
  const { Logger } = await import('nestjs-pino');
  const { AppModule } = await import('./app.module.js');

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix(API_PREFIX.slice(1), { exclude: ['health'] });
  app.enableShutdownHooks();
  await app.listen(env.PORT);
  app
    .get(Logger)
    .log(`[${APP_NAME}] server listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exit(1);
});
