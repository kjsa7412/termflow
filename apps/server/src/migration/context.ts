import { eq } from 'drizzle-orm';
import type pg from 'pg';
import type { Db } from '../db/client.js';
import { tfProject } from '../db/schema.js';
import type { ReportWriter } from './report-writer.js';

/**
 * 승계 러너 공용 타입(설계서 §2.5.9·§11.1·§11.5). step 이름·순서는 §11.1 표와 같다.
 * 단계 3(3a)은 1~8 + RECONCILE(1차 범위)을 구현하고, 9·10은 단계 5, 12는 단계 7이 잇는다.
 */
export const STEP_ORDER = [
  'LOAD_LEGACY',
  'TEMPLATE',
  'BIZ_AREA',
  'DOMAIN_CLS',
  'TERM',
  'DOMAIN',
  'CODE',
  'DEFAULT_COL',
  'COPY_TO_RMS',
  'TABLE',
  'RECONCILE',
  'DDL_REGRESSION',
] as const;
export type StepName = (typeof STEP_ORDER)[number];

/** 템플릿 "TermFlow 기본 표준 v1"(§11.1 step 2). */
export const STDV1 = { key: 'STDV1', nm: 'TermFlow 기본 표준 v1' } as const;
/** 승계 첫 프로젝트(§11.1 step 9, 단계 5). `--reset`은 두 키를 모두 지운다. */
export const RMS = { key: 'RMS', nm: '연구관리시스템(이관)' } as const;

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface RunOptions {
  runId: string;
  steps: StepName[];
  reset: boolean;
  nodeEnv: string;
  dumpPath: string;
  reportRoot: string;
  workDir: string;
  /** LOAD_LEGACY 전용 연결 설정(풀과 같은 대상). */
  connection: pg.ClientConfig;
}

export interface RuleCount {
  rule: string;
  source: number;
  loaded: number;
  excluded: number;
  flagged: number;
}

export interface StepResult {
  source: number;
  loaded: number;
  excluded: number;
  flagged: number;
  rules?: RuleCount[];
  message?: string;
}

export interface StepContext {
  runId: string;
  opts: RunOptions;
  pool: pg.Pool;
  db: Db;
  /** 트랜잭션 step이면 step 트랜잭션, 아니면 db. */
  tx: Tx | Db;
  report: ReportWriter;
  log: (msg: string) => void;
}

export interface StepDef {
  name: StepName;
  /** true면 대상이 비어 있지 않음 → SKIPPED(§11.5 선행 검사). */
  isDone: (ctx: Omit<StepContext, 'tx'>) => Promise<boolean>;
  run: (ctx: StepContext) => Promise<StepResult>;
  /** 기본 true: step 단위 트랜잭션(§11.5). LOAD_LEGACY는 전용 연결에서 자체 트랜잭션. */
  transactional?: boolean;
  /** false면 선행 검사 없이 매번 실행(RECONCILE: 읽기 전용 검증). */
  skippable?: boolean;
}

export class StepFailure extends Error {
  override name = 'StepFailure';
  constructor(
    message: string,
    readonly result?: StepResult,
  ) {
    super(message);
  }
}

/** STDV1 project_id. 없으면 선행 step(TEMPLATE) 누락으로 실패. */
export async function stdv1Id(db: Db | Tx): Promise<number> {
  const id = await findProjectId(db, STDV1.key);
  if (id === null)
    throw new StepFailure('템플릿 STDV1이 없습니다 — 먼저 TEMPLATE step을 실행하십시오');
  return id;
}

export async function findProjectId(db: Db | Tx, key: string): Promise<number | null> {
  const rows = await db
    .select({ id: tfProject.projectId })
    .from(tfProject)
    .where(eq(tfProject.projectKey, key));
  return rows[0]?.id ?? null;
}

/** "STDV1에 이 테이블 행이 있는가"(선행 검사 공용). STDV1이 없으면 false(→ 실행 시 실패). */
export async function stdv1Has(
  db: Db,
  count: (projectId: number) => Promise<number>,
): Promise<boolean> {
  const id = await findProjectId(db, STDV1.key);
  if (id === null) return false;
  return (await count(id)) > 0;
}
