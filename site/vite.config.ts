import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

/**
 * 소개 사이트(T12.7, CR-12 C1·C2): 제품과 따로 서는 정적 SPA. 색·글꼴 토큰은 제품의 `apps/web/src/styles/tokens.css`,
 * 화면 그림은 설명서와 같은 `docs/img/screens/*.png`를 가져다 쓴다(사본을 두지 않는다).
 * base — 루트(`/`)가 기본. 하위 경로에 올리면 `TERMFLOW_SITE_BASE=/termflow/`로 다시 빌드한다.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const base = process.env['TERMFLOW_SITE_BASE'] ?? '/';

export default defineConfig({
  base,
  plugins: [vue()],
  define: {
    __TF_VERSION__: JSON.stringify(pkg.version),
    __TF_BASE__: JSON.stringify(base),
  },
  server: { port: 5175, strictPort: true, fs: { allow: [ROOT] } },
  preview: { port: 5176 },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'jsdom',
    pool: 'vmThreads',
    maxWorkers: 2,
    testTimeout: 30_000,
  },
});
