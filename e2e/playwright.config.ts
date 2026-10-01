import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

/**
 * 브라우저 E2E(T10.4·T10.7, 설계서 §13.1): `pnpm e2e` → dev 서버(`pnpm dev`: 8080 + vite 5173)를 띄우거나 이미 떠 있으면 재사용하고,
 * dev DB(termflow-db, 호스트 포트 `.env`의 TERMFLOW_DB_PORT(기본 7341), RMS 33 테이블)를 대상으로 Chrome·Edge(설치된 브라우저 채널 — 별도 다운로드 없음, §12.7)에서 실행한다.
 * 로그인 계정은 루트 `.env`의 `TERMFLOW_ADMIN_LOGIN` + `TERMFLOW_ADMIN_DEV_CURRENT_PASSWORD`(dev에서 바꾼 현재 비밀번호)를 읽는다
 * — 값은 출력하지 않는다. 테스트가 만든 용어·테이블은 각 테스트가 끝날 때 API로 지운다(RMS 33 테이블 유지).
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readEnv(): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
    }
    return out;
  } catch {
    return {};
  }
}
const env = readEnv();
process.env['E2E_LOGIN'] ??= env['TERMFLOW_ADMIN_LOGIN'] ?? 'admin';
process.env['E2E_PASSWORD'] ??=
  env['TERMFLOW_ADMIN_DEV_CURRENT_PASSWORD'] ?? env['TERMFLOW_ADMIN_PASSWORD'] ?? '';

const BASE = process.env['E2E_BASE_URL'] ?? 'http://localhost:5173';

/**
 * Edge: 이 PC의 Edge는 패키지(Appx 서명) 설치라 `Application\msedge.exe`(런처)를 직접 실행하면 EACCES가 난다.
 * 버전 폴더(`Application\{버전}\msedge.exe`)의 실행 파일을 쓰고, 없으면 Playwright 채널(msedge)에 맡긴다(CR-10 C4).
 */
function edgeExecutable(): string | undefined {
  const app = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application';
  try {
    const ver = readdirSync(app)
      .filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d) && existsSync(path.join(app, d, 'msedge.exe')))
      .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))[0];
    return ver ? path.join(app, ver, 'msedge.exe') : undefined;
  } catch {
    return undefined;
  }
}
const edge = process.platform === 'win32' ? edgeExecutable() : undefined;

export default defineConfig({
  testDir: './tests',
  // dev DB를 공유하므로 한 번에 한 테스트(데이터 충돌 방지)
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  globalSetup: './tests/global-setup.ts',
  use: {
    baseURL: BASE,
    storageState: path.join(ROOT, 'e2e', '.auth', 'admin.json'),
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chrome', use: { channel: 'chrome' } },
    {
      name: 'msedge',
      use: edge ? { launchOptions: { executablePath: edge } } : { channel: 'msedge' },
    },
  ],
  webServer: {
    command: 'pnpm -C .. dev',
    // /health는 vite 프록시 경유 → 서버까지 떠야 200
    url: `${BASE}/health`,
    reuseExistingServer: true,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
