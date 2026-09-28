import 'reflect-metadata';
import { APP_NAME } from '@termflow/shared';
import { loadEnvOrExit } from './config/load-env.js';

async function main(): Promise<void> {
  // 환경 변수 검증을 AppModule 평가보다 먼저 끝낸다(누락 시 여기서 종료 코드 1).
  const env = loadEnvOrExit();

  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('./app.module.js');

  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(env.PORT);
  console.log(`[${APP_NAME}] server listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
