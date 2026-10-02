import { eq } from 'drizzle-orm';
import type pg from 'pg';
import type { Db } from '../db/client.js';
import { tfProject } from '../db/schema.js';
import { RETAIL_TEMPLATE } from '../project/builtin/builtin-template.js';
import type { ReportWriter } from './report-writer.js';

/**
 * 승계 러너 공용 타입(설계서 §2.5.9·§11.1·§11.5). step 이름·순서는 §11.1 표와 같다.
 * 단계 3(3a)은 1~8 + RECONCILE(1차 범위), 단계 5(3b)는 9 COPY_TO_RMS·10 TABLE·11 RECONCILE(전체 범위), 12는 단계 7.
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
  /** CR-09 R19: 이미 적재된 DB의 용어 기준 물리명 정정(새 적재는 대상 없음 — 멱등). */
  'TERM_UNIFY',
  'RECONCILE',
  'DDL_REGRESSION',
] as const;
export type StepName = (typeof STEP_ORDER)[number];

/**
 * 승계 템플릿 "패션·유통 표준 v1"(§11.1 step 2). CR-16 C1: 키 `STDV1`은 동봉 범용 기본 표준이 쓰고,
 * 승계 결과는 `RETAILV1`이다(옛 설치의 승계 STDV1은 기동 시 RETAILV1로 바뀐다 — `project/builtin`).
 */
export const SEED_TEMPLATE = RETAIL_TEMPLATE;
/** 승계 첫 프로젝트(§11.1 step 9, CR-01 A5). `--reset`은 두 키를 모두 지운다. */
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
  /** COPY_TO_RMS: RMS 프로젝트 관리자 로그인 ID(기본: 부트스트랩 관리자 TERMFLOW_ADMIN_LOGIN, §11.1 step 9). */
  rmsAdmin?: string;
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

/** 승계 템플릿(RETAILV1) project_id. 없으면 선행 step(TEMPLATE) 누락으로 실패. */
export async function templateId(db: Db | Tx): Promise<number> {
  const id = await findProjectId(db, SEED_TEMPLATE.key);
  if (id === null)
    throw new StepFailure('승계 템플릿 RETAILV1이 없습니다 — 먼저 TEMPLATE step을 실행하십시오');
  return id;
}

export async function findProjectId(db: Db | Tx, key: string): Promise<number | null> {
  const rows = await db
    .select({ id: tfProject.projectId })
    .from(tfProject)
    .where(eq(tfProject.projectKey, key));
  return rows[0]?.id ?? null;
}

/** "승계 템플릿에 이 테이블 행이 있는가"(선행 검사 공용). 템플릿이 없으면 false(→ 실행 시 실패). */
export async function templateHas(
  db: Db,
  count: (projectId: number) => Promise<number>,
): Promise<boolean> {
  const id = await findProjectId(db, SEED_TEMPLATE.key);
  if (id === null) return false;
  return (await count(id)) > 0;
}
