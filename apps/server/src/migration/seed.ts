/**
 * 승계 러너 CLI(`pnpm migrate:seed`, 설계서 §2.5.9·§11.1·§11.5, T3.2). 웹 서버를 띄우지 않는다. 종료 코드 0/1.
 *
 *   pnpm migrate:seed -- [--steps=LOAD_LEGACY..DEFAULT_COL] [--run-id=<uuid>] [--reset] [--no-reconcile] [--dump=<path>]
 *   (컨테이너) node dist/migration/seed.js …
 *
 * - `--steps`: `A..B` 범위, `A,B` 목록. 기본 `LOAD_LEGACY..DEFAULT_COL`(1차, §11.5)
 * - DEFAULT_COL을 포함하면 RECONCILE(1차 대사)을 자동으로 이어 실행한다(`--no-reconcile`로 끔, CR-03 C4)
 * - `--reset`(dev 전용): STDV1·RMS 삭제 후 실행. 범위에 LOAD_LEGACY가 있으면 legacy 스키마도 다시 적재
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvOrExit } from '../config/load-env.js';
import { createDb, createPool, poolConfig } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { RunOptions, StepName } from './context.js';
import { parseSteps, runSeed } from './runner.js';
import { STAGE3_STEPS } from './steps/index.js';

export const DEFAULT_STEPS = 'LOAD_LEGACY..DEFAULT_COL';
const DUMP_FILE = 'dump-gen_table-new.sql';

export interface CliArgs {
  runId: string;
  steps: StepName[];
  reset: boolean;
  dump: string | undefined;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (hit === undefined) return undefined;
    return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '';
  };
  const known = ['--steps', '--run-id', '--reset', '--no-reconcile', '--dump'];
  for (const a of argv) {
    if (a === '--') continue;
    if (!known.some((k) => a === k || a.startsWith(`${k}=`))) throw new Error(`알 수 없는 인자: ${a}`);
  }
  const runId = get('run-id') || randomUUID();
  if (runId.length > 36 || !/^[A-Za-z0-9_-]+$/.test(runId)) {
    throw new Error('--run-id는 영문·숫자·-·_ 36자 이내입니다');
  }
  const steps = parseSteps(get('steps') ?? DEFAULT_STEPS);
  if (steps.includes('DEFAULT_COL') && !steps.includes('RECONCILE') && get('no-reconcile') === undefined) {
    steps.push('RECONCILE');
  }
  return { runId, steps, reset: get('reset') !== undefined, dump: get('dump') || undefined };
}

/** pnpm-workspace.yaml이 있는 디렉터리(없으면 이 파일 기준 저장소 루트 추정). */
export function workspaceRoot(start: string = process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
}

function resolveDump(explicit: string | undefined, envValue: string, root: string): string {
  const candidates = [
    explicit,
    envValue,
    path.join(root, 'seed', 'original', DUMP_FILE),
    path.join('/seed', 'original', DUMP_FILE),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    const p = path.isAbsolute(c) ? c : path.resolve(root, c);
    if (existsSync(p)) return p;
  }
  throw new Error(`승계 dump를 찾을 수 없습니다: ${candidates.join(' | ')}`);
}

async function main(): Promise<number> {
  process.env['TZ'] ??= 'Asia/Seoul';
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnvOrExit();
  const root = workspaceRoot();
  const reportRoot = path.isAbsolute(env.TERMFLOW_REPORT_DIR)
    ? env.TERMFLOW_REPORT_DIR
    : path.resolve(root, env.TERMFLOW_REPORT_DIR);
  const needsDump = args.steps.includes('LOAD_LEGACY');
  const cfg = poolConfig(env);
  const opts: RunOptions = {
    runId: args.runId,
    steps: args.steps,
    reset: args.reset,
    nodeEnv: env.NODE_ENV,
    dumpPath: needsDump ? resolveDump(args.dump, env.TERMFLOW_LEGACY_DUMP, root) : '',
    reportRoot,
    workDir: path.join(root, 'migration', 'work'),
    connection: {
      host: cfg.host,
      port: cfg.port,
      database: cfg.database,
      user: cfg.user,
      password: typeof cfg.password === 'string' ? cfg.password : undefined,
      options: cfg.options,
      application_name: 'termflow-migrate-legacy',
    },
  };
  const pool = createPool(env);
  try {
    await runMigrations(pool); // 스키마 전진(서버 기동과 같은 규칙)
    const db = createDb(pool);
    console.log(`[migrate:seed] run_id=${opts.runId} steps=${opts.steps.join(',')}${opts.reset ? ' --reset' : ''}`);
    const summary = await runSeed(opts, { pool, db, steps: STAGE3_STEPS });
    console.log(
      `[migrate:seed] ${summary.ok ? '완료' : '실패'} ${summary.seconds.toFixed(2)}s — 리포트 ${summary.reportDir}`,
    );
    return summary.ok ? 0 : 1;
  } finally {
    await pool.end();
  }
}

const isEntry = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(`[migrate:seed] ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
      process.exit(1);
    });
}
