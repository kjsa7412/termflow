import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// pnpm test:db — Testcontainers(Docker 필요) 테스트. 컨테이너 1개를 globalSetup에서 기동한다(§2.5.7).
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/db/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['test/db/setup/global-setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
