import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseEnv, type Env } from './env.schema.js';

/**
 * `.env` 위치: `TERMFLOW_ENV_FILE`이 있으면 그 경로, 없으면 현재 디렉터리부터
 * 워크스페이스 루트(pnpm-workspace.yaml이 있는 디렉터리)까지 올라가며 찾는다.
 * 컨테이너(prod)는 compose `env_file`로 주입하므로 파일이 없어도 된다.
 */
export function findEnvFile(startDir: string = process.cwd()): string | undefined {
  const explicit = process.env['TERMFLOW_ENV_FILE'];
  if (explicit) {
    return existsSync(explicit) ? path.resolve(explicit) : undefined;
  }
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** `.env`를 읽고(이미 설정된 변수는 덮어쓰지 않음) 검증한다. 실패 시 누락 변수명을 출력하고 종료 코드 1. */
export function loadEnvOrExit(): Env {
  const envFile = findEnvFile();
  if (envFile) {
    process.loadEnvFile(envFile);
  }
  const result = parseEnv(process.env);
  if (result.ok) {
    return result.env;
  }
  const lines = [
    '[termflow] 환경 변수 검증 실패 — 서버를 기동하지 않습니다.',
    `  .env 파일: ${envFile ?? '없음(루트의 .env.example을 복사해 .env를 만드십시오)'}`,
  ];
  if (result.missing.length > 0) {
    lines.push(`  누락: ${result.missing.join(', ')}`);
  }
  for (const { name, message } of result.invalid) {
    lines.push(`  형식 오류: ${name} — ${message}`);
  }
  console.error(lines.join('\n'));
  process.exit(1);
}
