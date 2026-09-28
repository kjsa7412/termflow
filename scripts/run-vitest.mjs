#!/usr/bin/env node
// vitest 실행 래퍼: pnpm 10은 `pnpm test:db -- poc`의 `--`를 그대로 넘기므로(npm과 다름)
// vitest가 뒤따르는 파일 필터를 무시한다. `--` 토큰만 제거하고 나머지 인자는 그대로 vitest에 전달한다.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const vitestBin = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const args = process.argv.slice(2).filter((a) => a !== '--');

const result = spawnSync(process.execPath, [vitestBin, ...args], { stdio: 'inherit' });
process.exit(result.status ?? 1);
