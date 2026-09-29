import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// NestJS DI는 emitDecoratorMetadata가 필요하므로 esbuild/oxc 대신 SWC로 변환한다.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/unit/**/*.test.ts', 'test/api/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    // 병렬 실행(pnpm -r test: 서버·웹 동시, 파일당 워커)에서 Nest 앱 import·부트스트랩이 CPU 경합으로 10초(기본)를
    // 넘길 수 있다 — 훅·테스트 제한을 넉넉히 두어 부하에 따른 시간 초과(불안정 실패)를 없앤다(CR-05 C1).
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
