import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// pnpm test:db — Testcontainers(Docker 필요) 테스트. 단계 1·2에서 test/db/**를 채운다.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/db/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
