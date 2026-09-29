#!/usr/bin/env node
// vitest 실행 래퍼: pnpm 10은 `pnpm test:db -- poc`의 `--`를 그대로 넘기므로(npm과 다름)
// vitest가 뒤따르는 파일 필터를 무시한다. `--` 토큰만 제거하고 나머지 인자는 그대로 vitest에 전달한다.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const vitestBin = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const args = process.argv.slice(2).filter((a) => a !== '--');
// 파일 필터(옵션이 아닌 인자)가 있으면 격리 실행으로 보고 성능 판정을 엄격 기준으로 한다(test/db/setup/perf.ts, CR-05 C1)
const run = args[0] === 'run' ? args.slice(1) : args;
const filtered = run.some((a, i) => !a.startsWith('-') && !(i > 0 && run[i - 1] === '--config'));

const result = spawnSync(process.execPath, [vitestBin, ...args], {
  stdio: 'inherit',
  env: { ...process.env, TF_TEST_ISOLATED: filtered ? '1' : '0' },
});
process.exit(result.status ?? 1);
