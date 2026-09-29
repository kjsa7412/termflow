import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 애플리케이션 동봉 리소스(설계서 §6.3·§6.9: `apps/server/resources/ddl/…`, 이미지에 복사).
 * `src/ddl/*.ts`(tsx·vitest)와 `dist/ddl/*.js`(빌드) 모두 두 단계 위가 `apps/server`다.
 */
export function resourcesDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.resolve(here, '../../resources');
  if (!existsSync(dir)) throw new Error(`DDL 리소스 디렉터리가 없습니다: ${dir}`);
  return dir;
}

export function ddlResource(...parts: string[]): string {
  return path.join(resourcesDir(), 'ddl', ...parts);
}
