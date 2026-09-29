import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import type { Db } from '../../../src/db/client.js';
import type { RunOptions, StepName } from '../../../src/migration/context.js';
import { runSeed, type RunSummary } from '../../../src/migration/runner.js';
import { SEED_STEPS } from '../../../src/migration/steps/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
export const DUMP = path.join(ROOT, 'seed', 'original', 'dump-gen_table-new.sql');

/** 승계 1차(§11.5): LOAD_LEGACY..DEFAULT_COL + RECONCILE. */
export const PHASE1: StepName[] = [
  'LOAD_LEGACY',
  'TEMPLATE',
  'BIZ_AREA',
  'DOMAIN_CLS',
  'TERM',
  'DOMAIN',
  'CODE',
  'DEFAULT_COL',
  'RECONCILE',
];
/** 승계 2차(게이트 5): COPY_TO_RMS..RECONCILE. */
export const PHASE2: StepName[] = ['COPY_TO_RMS', 'TABLE', 'RECONCILE'];

/** 픽스처와 같은 bcrypt 해시(원문 FIXTURE_PASSWORD, 테스트 전용). */
export const FIXTURE_HASH = '$2b$10$pZUk3zRUImVCkeFRrfGPled5xT6epm5BvJHPQGuXnAalrQdSBZL9m';

export function seedOptions(
  url: string,
  reportRoot: string,
  runId: string,
  steps: StepName[],
  extra: Partial<RunOptions> = {},
): RunOptions {
  return {
    runId,
    steps,
    reset: false,
    nodeEnv: 'test',
    dumpPath: DUMP,
    reportRoot,
    workDir: path.join(reportRoot, 'work'),
    connection: { connectionString: url },
    rmsAdmin: 'admin',
    ...extra,
  };
}

export function tempReportRoot(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function runSteps(
  ctx: { pool: pg.Pool; db: Db; url: string },
  reportRoot: string,
  runId: string,
  steps: StepName[],
  extra: Partial<RunOptions> = {},
): Promise<RunSummary> {
  return runSeed(seedOptions(ctx.url, reportRoot, runId, steps, extra), {
    pool: ctx.pool,
    db: ctx.db,
    steps: SEED_STEPS,
    log: () => {},
  });
}

/**
 * 사용자(역할 테스트용): admin(부트스트랩과 같은 시스템 관리자), sysadmin, pa, editor, viewer, nobody.
 * 비밀번호는 모두 FIXTURE_PASSWORD, 강제 변경 없음.
 */
export async function insertUsers(pool: pg.Pool): Promise<Record<string, number>> {
  await pool.query(
    `insert into tf_user (login_id, user_nm, password_hash, is_sys_admin, pw_change_required, created_by, updated_by)
     select v.login_id, v.nm, $1, v.sa, false, 'SYSTEM', 'SYSTEM'
       from (values ('admin', '초기관리자', true), ('sysadmin', '시스템관리자', true), ('pa', '프로젝트관리자', false),
                    ('editor', '편집자', false), ('editor1', '편집자1', false), ('viewer', '조회자', false),
                    ('nobody', '무소속', false)) v(login_id, nm, sa)
     on conflict (login_id) do nothing`,
    [FIXTURE_HASH],
  );
  const { rows } = await pool.query<{ login_id: string; user_id: number }>(
    'select login_id, user_id from tf_user',
  );
  return Object.fromEntries(rows.map((r) => [r.login_id, r.user_id]));
}
