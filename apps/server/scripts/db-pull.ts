/**
 * `pnpm db:pull`(T2.2, 설계서 §2.5.3): DB에서 schema.ts를 역생성한다.
 *  1. drizzle-kit pull → 임시 폴더 `.drizzle-pull/`(pull은 out에 journal·SQL도 쓰므로 drizzle/를 쓰지 않는다)
 *  2. pull-postprocess.ts로 FK 제거·머리말 추가(PoC T1.4 발견 제약)
 *  3. prettier 형식으로 `src/db/schema.ts`에 쓴다. 생성 relations.ts는 버리고 손으로 쓴 src/db/relations.ts를 쓴다.
 * 대상 DB는 .env의 TERMFLOW_DB_*(마이그레이션이 적용된 상태여야 한다: `pnpm db:migrate`).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';
import { loadEnvOrExit } from '../src/config/load-env.js';
import { dbUrlWithAuth } from '../src/db/client.js';
import { postprocessSchema } from './pull-postprocess.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(serverRoot, '.drizzle-pull');
const target = path.join(serverRoot, 'src', 'db', 'schema.ts');

async function main(): Promise<void> {
  const env = loadEnvOrExit();
  rmSync(outDir, { recursive: true, force: true });
  const kitBin = path.join(serverRoot, 'node_modules', 'drizzle-kit', 'bin.cjs');
  const res = spawnSync(
    process.execPath,
    [kitBin, 'pull', '--dialect=postgresql', `--url=${dbUrlWithAuth(env)}`, `--out=${outDir}`],
    { cwd: serverRoot, stdio: ['ignore', 'inherit', 'inherit'] },
  );
  if (res.status !== 0) throw new Error(`drizzle-kit pull 실패(종료 코드 ${res.status})`);
  const raw = readFileSync(path.join(outDir, 'schema.ts'), 'utf8');
  const processed = postprocessSchema(raw);
  const options = (await prettier.resolveConfig(target)) ?? {};
  writeFileSync(target, await prettier.format(processed, { ...options, filepath: target }));
  rmSync(outDir, { recursive: true, force: true });
  console.log(`[db:pull] ${path.relative(serverRoot, target)} 갱신`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
