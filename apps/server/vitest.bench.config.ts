import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';
import { HAS_LEGACY_DUMP } from './test/local-sources.js';

// pnpm --filter @termflow/server bench -- autocomplete — 성능 측정(T9.11, 설계서 §5.8·§12.1·G6).
// test:db와 같은 컨테이너 준비(globalSetup)를 쓰고, 측정 파일(test/bench)만 순차 실행한다(병렬 부하 없이 측정).
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    // 측정 데이터는 승계 원본 dump로 만든다 — dump가 없는 곳(저장소에 없음)에서는 측정 파일이 없다
    include: HAS_LEGACY_DUMP ? ['test/bench/**/*.test.ts'] : [],
    passWithNoTests: true,
    environment: 'node',
    globalSetup: ['test/db/setup/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
