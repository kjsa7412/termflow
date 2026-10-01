import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';
import { manualPlugin } from './build/manual.js';

const SERVER = process.env['TERMFLOW_DEV_SERVER_URL'] ?? 'http://localhost:8080';
const ROOT_PKG = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as {
  version: string;
};

// 설계서 §2.5.6: vite 개발 서버(5173) → /api 프록시 → 서버 8080.
// /health는 업무 API 접두어(/api/v1) 밖에 있으므로 따로 프록시한다.
// 제품 내 설명서 원문은 저장소 docs/(T12.5, CR-12 C4) — 이미지 빌드는 .dockerignore 예외로 그 파일만 넣는다(C5)
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  plugins: [vue(), manualPlugin(REPO_ROOT)],
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
    include: ['src/**/*.test.ts', 'build/**/*.test.ts'],
    environment: 'jsdom',
    // 불안정 실패 원인 제거(CR-10 C1): 기본 forks 풀은 테스트 파일마다 새 프로세스에서 jsdom을 다시 만든다
    // (단독 1.9초, 서버 테스트와 동시 실행 시 파일당 약 11초 · 11파일 합계 127초). 부하가 크면 워커 준비가
    // vitest의 워커 시작 제한(60초)을 넘기고 파일이 테스트 0건으로 실패했다. vmThreads는 워커당 jsdom을 한 번 만들고
    // 파일마다 새 VM 컨텍스트로 격리를 유지한다. 워커 수를 4로 묶어 서버 테스트(pnpm -r test 병렬)와의 CPU·메모리 경합도 줄인다.
    pool: 'vmThreads',
    maxWorkers: 4,
    // jsdom 환경 준비가 병렬 실행(서버 테스트와 동시)에서 수 초씩 걸린다 — 기본 5초 제한 대신 넉넉히(CR-05 C1).
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
