import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DynamicModule } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';

/**
 * 프로덕션 서빙 골격(T4.12, 설계서 §2.5.8): 웹 빌드(`apps/web/dist`)를 같은 8080에서 제공하고,
 * 페이지 경로는 항상 index.html(SPA 폴백, history 라우터). `/api/**`·`/health`·`/metrics`·`/mcp`(CR-18)는 제외해 API 404가 ProblemDetail로 나간다.
 * 빌드 산출물이 없으면(웹 개발 서버 5173 사용 중) 모듈을 붙이지 않는다.
 */
export const WEB_DIST = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../web/dist',
);
export const WEB_EXCLUDE = /^\/(api|health|metrics|mcp)(\/|$)/;

export function webStaticModules(dist: string = WEB_DIST): DynamicModule[] {
  if (!existsSync(path.join(dist, 'index.html'))) return [];
  return [
    ServeStaticModule.forRoot({
      rootPath: dist,
      exclude: WEB_EXCLUDE,
      serveStaticOptions: { index: false, fallthrough: true, maxAge: '1h' },
    }),
  ];
}
