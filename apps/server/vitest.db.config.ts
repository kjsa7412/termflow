import swc from 'unplugin-swc';
import { configDefaults, defineConfig } from 'vitest/config';
import { HAS_LEGACY_DUMP, LEGACY_DUMP_DB_TESTS } from './test/local-sources.js';

// pnpm test:db — Testcontainers(Docker 필요) 테스트. 컨테이너 1개를 globalSetup에서 기동한다(§2.5.7).
// 승계 원본 dump는 저장소에 없다(개발 PC에만) — 없으면 그 dump로 승계해 쓰는 파일을 뺀다(CI·새 clone).
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/db/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...(HAS_LEGACY_DUMP ? [] : LEGACY_DUMP_DB_TESTS)],
    environment: 'node',
    globalSetup: ['test/db/setup/global-setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
