import { defineConfig } from '@playwright/test';

/** 소개 사이트 검수(T12.7) — 사이트 개발 서버(5175) 또는 미리보기(5176)를 대상으로. 로그인·DB 없음. */
process.env['SITE_REVIEW'] ??= '1';

export default defineConfig({
  testDir: './tests',
  testMatch: /site-review\.spec\.ts$/,
  workers: 2,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: 'test-results/site-review-runs',
  use: {
    baseURL: process.env['SITE_URL'] ?? 'http://localhost:5175',
    locale: 'ko-KR',
    channel: 'chrome',
  },
});
