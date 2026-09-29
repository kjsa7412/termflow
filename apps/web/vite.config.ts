import { readFileSync } from 'node:fs';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

const SERVER = process.env['TERMFLOW_DEV_SERVER_URL'] ?? 'http://localhost:8080';
const ROOT_PKG = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as {
  version: string;
};

// 설계서 §2.5.6: vite 개발 서버(5173) → /api 프록시 → 서버 8080.
// /health는 업무 API 접두어(/api/v1) 밖에 있으므로 따로 프록시한다.
export default defineConfig({
  plugins: [vue()],
  define: { __APP_VERSION__: JSON.stringify(ROOT_PKG.version) },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: SERVER, changeOrigin: true },
      '/health': { target: SERVER, changeOrigin: true },
    },
  },
  preview: {
    port: 4173,
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'jsdom',
    // jsdom 환경 준비가 병렬 실행(서버 테스트와 동시)에서 수 초씩 걸린다 — 기본 5초 제한 대신 넉넉히(CR-05 C1).
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
