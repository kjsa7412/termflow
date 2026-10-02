import path from 'node:path';
import { inArray } from 'drizzle-orm';
import type pg from 'pg';
import type { MigrationStatus } from '@termflow/shared';
import type { Db } from '../db/client.js';
import { tfProject } from '../db/schema.js';
import {
  RMS,
  SEED_TEMPLATE,
  STEP_ORDER,
  StepFailure,
  type RunOptions,
  type StepContext,
  type StepDef,
  type StepName,
  type StepResult,
} from './context.js';
import { dropLegacy } from './legacy-loader.js';
import { ReportWriter, SUMMARY_HEADER } from './report-writer.js';

/**
 * 승계 러너 본체(T3.2, 설계서 §2.5.9·§11.5).
 *  - step 단위 트랜잭션, 대상이 비어 있지 않으면 SKIPPED(선행 검사)
 *  - 실행 결과를 `migration_log`(step 1행 + 규칙별 행)와 `summary.csv`에 남긴다
 *  - 실패한 step에서 멈추고 `ok=false`(CLI 종료 코드 1)
 *  - `--reset`(dev 전용): 승계 템플릿 RETAILV1·RMS 삭제(CASCADE, 범용 STDV1은 지우지 않는다). 요청 범위에 LOAD_LEGACY가 있으면 legacy 스키마도 지운다(CR-03 C4)
 * 웹 서버를 띄우지 않는다(Nest 비의존).
 */
export interface StepLog {
  step: StepName;
  status: MigrationStatus;
  seconds: number;
  result: StepResult | null;
  message: string | null;
}

export interface RunSummary {
  runId: string;
  ok: boolean;
  steps: StepLog[];
  reportDir: string;
  files: string[];
  seconds: number;
}

export class ResetRefusedError extends Error {
  override name = 'ResetRefusedError';
}

/** `A..B`(범위), `A,B`(목록), `A`(단일). 빈 문자열은 빈 목록. 순서는 항상 STEP_ORDER. */
export function parseSteps(spec: string | undefined): StepName[] {
  if (spec === undefined) return [];
  const s = spec.trim().toUpperCase();
  if (s === '') return [];
  const idx = (n: string): number => {
    const i = (STEP_ORDER as readonly string[]).indexOf(n.trim());
    if (i < 0) throw new Error(`알 수 없는 step: ${n} (가능: ${STEP_ORDER.join(', ')})`);
    return i;
  };
  if (s.includes('..')) {
    const [a, b] = s.split('..');
    const from = idx(a ?? '');
    const to = idx(b ?? '');
    if (from > to) throw new Error(`step 범위가 거꾸로입니다: ${spec}`);
    return STEP_ORDER.slice(from, to + 1);
  }
  const set = new Set(s.split(',').map(idx));
  return STEP_ORDER.filter((_, i) => set.has(i));
}

export async function resetTargets(
  pool: pg.Pool,
  db: Db,
  opts: Pick<RunOptions, 'nodeEnv' | 'steps'>,
): Promise<{ projects: number; legacyDropped: boolean }> {
  if (opts.nodeEnv === 'production') {
    throw new ResetRefusedError('--reset은 production에서 실행할 수 없습니다(dev 전용)');
  }
  const deleted = await db
    .delete(tfProject)
    .where(inArray(tfProject.projectKey, [SEED_TEMPLATE.key, RMS.key]))
    .returning({ id: tfProject.projectId });
  const legacyDropped = opts.steps.includes('LOAD_LEGACY');
  if (legacyDropped) await dropLegacy(pool);
  return { projects: deleted.length, legacyDropped };
}

const round = (ms: number) => Math.round(ms / 10) / 100;
const READ_ONLY_STEPS: ReadonlySet<StepName> = new Set(['RECONCILE', 'DDL_REGRESSION']);

async function writeLog(
  pool: pg.Pool,
  runId: string,
  log: StepLog,
  startedAt: Date,
  reportPath: string,
): Promise<void> {
  const rows: [string | null, number, number, number, number][] = [
    [
      null,
      log.result?.source ?? 0,
      log.result?.loaded ?? 0,
      log.result?.excluded ?? 0,
      log.result?.flagged ?? 0,
    ],
    ...(log.result?.rules ?? []).map((r): [string, number, number, number, number] => [
      r.rule,
      r.source,
      r.loaded,
      r.excluded,
      r.flagged,
    ]),
  ];
  for (const [rule, source, loaded, excluded, flagged] of rows) {
    await pool.query(
      `insert into migration_log
         (run_id, step, rule_id, source_cnt, loaded_cnt, excluded_cnt, flagged_cnt, status, message, report_path, started_at, finished_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, CURRENT_TIMESTAMP)`,
      [
        runId,
        log.step,
        rule,
        source,
        loaded,
        excluded,
        flagged,
        log.status,
        rule === null ? log.message : null,
        reportPath,
        startedAt.toISOString(),
      ],
    );
  }
}

export async function runSeed(
  opts: RunOptions,
  deps: { pool: pg.Pool; db: Db; steps: ReadonlyMap<StepName, StepDef>; log?: (m: string) => void },
): Promise<RunSummary> {
  const t0 = performance.now();
  const log = deps.log ?? ((m: string) => console.log(m));
  const report = new ReportWriter(opts.reportRoot, opts.runId);
  const reportPath = path.relative(process.cwd(), report.dir).replaceAll('\\', '/').slice(0, 200);

  for (const s of opts.steps) {
    if (!deps.steps.has(s)) {
      throw new Error(`step ${s}는 구현되지 않았습니다`);
    }
  }
  if (opts.reset) {
    const r = await resetTargets(deps.pool, deps.db, opts);
    log(
      `[migrate:seed] --reset: 프로젝트 ${r.projects}건 삭제${r.legacyDropped ? ', legacy 스키마 삭제' : ''}`,
    );
  }

  const logs: StepLog[] = [];
  let ok = true;
  for (const name of opts.steps) {
    const def = deps.steps.get(name)!;
    const startedAt = new Date();
    const ts = performance.now();
    const base: Omit<StepContext, 'tx'> = {
      runId: opts.runId,
      opts,
      pool: deps.pool,
      db: deps.db,
      report,
      log,
    };
    let entry: StepLog;
    try {
      if (def.skippable !== false && (await def.isDone(base))) {
        entry = {
          step: name,
          status: 'SKIPPED',
          seconds: 0,
          result: null,
          message: '대상이 비어 있지 않음',
        };
      } else {
        const result =
          def.transactional === false
            ? await def.run({ ...base, tx: deps.db })
            : await deps.db.transaction((tx) => def.run({ ...base, tx }));
        entry = {
          step: name,
          status: 'SUCCESS',
          seconds: round(performance.now() - ts),
          result,
          message: result.message ?? null,
        };
      }
    } catch (e) {
      ok = false;
      const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      entry = {
        step: name,
        status: 'FAILED',
        seconds: round(performance.now() - ts),
        result: e instanceof StepFailure ? (e.result ?? null) : null,
        message: message.slice(0, 4000),
      };
    }
    logs.push(entry);
    await writeLog(deps.pool, opts.runId, entry, startedAt, reportPath);
    const r = entry.result;
    log(
      `[migrate:seed] ${name.padEnd(12)} ${entry.status.padEnd(7)} ${entry.seconds.toFixed(2)}s` +
        (r ? ` 원본 ${r.source} · 적재 ${r.loaded} · 제외 ${r.excluded} · 검토 ${r.flagged}` : '') +
        (entry.message && entry.status !== 'SUCCESS' ? ` — ${entry.message}` : ''),
    );
    if (!ok) break;
  }

  // 대량 적재 직후에는 통계가 없어(autovacuum 전) 목록·검색 쿼리가 나쁜 계획을 고른다 → 적재한 표를 바로 ANALYZE(CR-05 C7)
  // 읽기 전용 검증 step(RECONCILE·DDL_REGRESSION)만 돌았으면 적재가 없으므로 생략
  if (logs.some((l) => l.status === 'SUCCESS' && !READ_ONLY_STEPS.has(l.step))) {
    await deps.pool.query(
      'ANALYZE prj_biz_area, std_term, std_domain_cls, std_domain, std_code_cls, std_code, std_default_col_set, std_default_col, prj_table, prj_column',
    );
  }

  const files = report.flush();
  const summaryRows: unknown[][] = [];
  for (const l of logs) {
    const r = l.result;
    summaryRows.push([
      l.step,
      '',
      r?.source ?? 0,
      r?.loaded ?? 0,
      r?.excluded ?? 0,
      r?.flagged ?? 0,
      l.status,
      l.seconds,
    ]);
    for (const rc of r?.rules ?? []) {
      summaryRows.push([
        l.step,
        rc.rule,
        rc.source,
        rc.loaded,
        rc.excluded,
        rc.flagged,
        l.status,
        '',
      ]);
    }
  }
  files.push(report.writeTable('summary', SUMMARY_HEADER, summaryRows));
  return {
    runId: opts.runId,
    ok,
    steps: logs,
    reportDir: report.dir,
    files,
    seconds: round(performance.now() - t0),
  };
}
