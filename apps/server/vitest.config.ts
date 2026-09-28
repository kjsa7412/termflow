import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// NestJS DI는 emitDecoratorMetadata가 필요하므로 esbuild/oxc 대신 SWC로 변환한다.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/unit/**/*.test.ts', 'test/api/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
  },
});
