import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

/**
 * 소개 사이트·설명서 그림(T12.6, CR-12 C3): **데모 인스턴스**(승계 없이 범용 기본 표준 STDV1만, 가상 프로젝트 EDU)를 찍어 `docs/img/screens/*.png`로 저장한다.
 * dev DB(RMS 실데이터)를 쓰는 일반 E2E(`playwright.config.ts`)와 따로 돈다.
 *
 *   DEMO_BASE_URL=http://localhost:8095 DEMO_ADMIN_PASSWORD=<데모 인스턴스 .env의 초기 관리자 비밀번호> \
 *     pnpm -C e2e exec playwright test -c site-shots.config.ts
 *
 * 처음 한 번 관리자 강제 비밀번호 변경·데모 데이터 생성(`tests/demo-seed.ts`)을 하고, 바꾼 데모 비밀번호는 `e2e/.auth/`(gitignore)에 둔다.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env['SITE_SHOTS'] ??= '1';

export default defineConfig({
  testDir: './tests',
  testMatch: /site-shots\.spec\.ts$/,
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results/site-shots',
  globalSetup: './tests/demo-setup.ts',
  use: {
    baseURL: process.env['DEMO_BASE_URL'] ?? 'http://localhost:8095',
    storageState: path.join(ROOT, 'e2e', '.auth', 'demo-admin.json'),
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    channel: 'chrome',
  },
});
