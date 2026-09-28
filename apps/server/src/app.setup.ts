import type { INestApplication } from '@nestjs/common';
import { API_PREFIX } from '@termflow/shared';
import { applyHttpSecurity } from './auth/http-security.js';

/**
 * Nest 앱 공통 구성(main.ts·API 통합 테스트 공용): 보안 미들웨어(helmet·cookie·session·csrf) → 전역 접두어 `/api/v1`.
 * `/health`는 접두어 밖(§2.8). 웹 정적 파일(T4.12)은 AppModule의 ServeStaticModule이 붙인다.
 */
export function configureApp(app: INestApplication): INestApplication {
  applyHttpSecurity(app);
  app.setGlobalPrefix(API_PREFIX.slice(1), { exclude: ['health'] });
  return app;
}
