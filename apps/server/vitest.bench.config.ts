import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// pnpm --filter @termflow/server bench -- autocomplete — 성능 측정(T9.11, 설계서 §5.8·§12.1·G6).
// test:db와 같은 컨테이너 준비(globalSetup)를 쓰고, 측정 파일(test/bench)만 순차 실행한다(병렬 부하 없이 측정).
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/bench/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['test/db/setup/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
