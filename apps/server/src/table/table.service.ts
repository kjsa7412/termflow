import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  API_ERROR_CODES,
  MEMBER_ROLE_RANK,
  VALIDATION_CODES,
  type ColumnInput,
  type Dialect,
  type HistoryAction,
  type TableCreateInput,
  type TableDetail,
  type TableHeaderItem,
  type TableHistoryDetail,
  type TableHistoryItem,
  type TableSaveResponse,
  type TableSnapshot,
  type TableStatus,
  type TableStatusResponse,
  type TableValidateResponse,
  type ValidationIssue,
} from '@termflow/shared';
import { columnTermHint } from '../autocomplete/engine.js';
import { TermCacheRegistry } from '../autocomplete/term-cache-registry.js';
import type { Audit } from '../common/audit/audit.js';
import {
  ConflictProblem,
  ForbiddenProblem,
  NotFoundProblem,
  ValidationProblem,
} from '../common/problem/problem.exception.js';
import type { ProjectCtx } from '../common/project-context.js';
import { insertAudited, updateAudited } from '../db/audit.js';
import type { Db } from '../db/client.js';
import { DRIZZLE } from '../db/db.module.js';
import { prjColumn, prjTable, prjTableHistory } from '../db/schema.js';
import { validateTable } from '../ddl/validator.js';
import { rowsOf, type ExecQ } from '../project/sql-util.js';
import {
  changeSummaryText,
  planColumnDiff,
  type DiffPlan,
  type IncomingColumn,
} from './column-diff.js';
import {
  buildSnapshot,
  loadColumns,
  loadHeader,
  readSnapshot,
  toExisting,
} from './table-detail.loader.js';
import { draftModel, loadBizAreas, loadSuffixes } from './table-model.loader.js';

/** Db 또는 트랜잭션. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface Checked {
  input: TableCreateInput;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/** 저장 경로의 추가 동작(복원·복제가 같은 경로를 쓴다). */
export interface SaveMode {
  action: Extract<HistoryAction, 'UPDATE' | 'RESTORE'>;
  /** RESTORE: "v2 복원" 접두. */
  summaryPrefix?: string;
  extra?: Pick<TableSnapshot, 'restoredFrom'>;
}

const colValues = (c: ColumnInput, seq: number) => ({
  colSeq: seq,
  logicalNm: c.logicalNm,
  physicalNm: c.physicalNm,
  isPk: c.isPk,
  dataType: c.dataType,
  dataLength: c.dataLength,
  dataScale: c.dataScale,
  isNullable: c.isNullable,
  defaultVal: c.defaultVal,
  colComment: c.colComment,
  domainId: c.domainId,
  codeClsId: c.codeClsId,
  defaultColId: c.defaultColId,
  matchType: c.matchType,
});

type RefCols = Pick<ColumnInput, 'domainId' | 'codeClsId' | 'defaultColId'>;
const REF_TABLES = [
  ['std_domain', 'domain_id', 'domainId'],
  ['std_code_cls', 'code_cls_id', 'codeClsId'],
  ['std_default_col', 'default_col_id', 'defaultColId'],
] as const;

/** 컬럼 참조(도메인·코드구분·기본컬럼) 중 이 프로젝트에 실제로 있는 ID 집합 3개(순서 = REF_TABLES). */
export async function refSets(
  q: ExecQ,
  projectId: number,
  columns: readonly RefCols[],
): Promise<[Set<number>, Set<number>, Set<number>]> {
  const sets = await Promise.all(
    REF_TABLES.map(async ([table, col, field]) => {
      const list = [
        ...new Set(columns.map((c) => c[field]).filter((x): x is number => x !== null)),
      ];
      if (list.length === 0) return new Set<number>();
      const rows = await rowsOf<{ id: number }>(
        q,
        sql`select ${sql.identifier(col)} id from ${sql.identifier(table)}
             where project_id = ${projectId} and ${sql.identifier(col)} = any(${sql.param(list)}::int[])`,
      );
      return new Set(rows.map((r) => r.id));
    }),
  );
  return [sets[0]!, sets[1]!, sets[2]!];
}

/**
 * 저장 전 정규화(§5.5·§5.7): 물리명(테이블·컬럼) 앞뒤 공백 제거 + 대문자, PK는 NOT NULL로 자동 보정
 * (E_PK_NULLABLE은 "보정 후에도 남으면" — 보정이 항상 이기므로 API로는 발생하지 않는다, CR-07 C3).
 */
export function normalizeInput(input: TableCreateInput): TableCreateInput {
  return {
    table: { ...input.table, tableNm: input.table.tableNm.trim().toUpperCase() },
    columns: input.columns.map((c) => ({
      ...c,
      physicalNm: c.physicalNm.trim().toUpperCase(),
      isNullable: c.isPk ? false : c.isNullable,
    })),
  };
}

/**
 * 테이블 설계 쓰기·조회(단계 8, 설계서 §8.1~§8.4·§9.3, T8.1~T8.5).
 *  - 낙관적 잠금: `UPDATE … WHERE version = ?` 0행이면 409 version-conflict + `current`(재조회 불필요)
 *  - 저장 diff: 컬럼 ID 기준(§8.2, column-diff.ts), 스냅샷 이력 1행/저장(§8.3)
 *  - 저장 전 검증: TableValidator(§5.7, DDL과 같은 모듈) + 참조 소속 검사(IDOR, CR-01-3) → E가 있으면 422
 *  - FINAL: 편집·복원 409 `E_TABLE_FINAL`, 확정 해제는 프로젝트 관리자(§8.4)
 *  - 템플릿: 테이블 쓰기 409 `E_TEMPLATE_NO_TABLES`(CR-04 C9)
 */
@Injectable()
export class TableService {
  private readonly logger = new Logger('Tables');

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: TermCacheRegistry,
  ) {}

  // ── 공통 ──────────────────────────────────────────────────────────
  assertNotTemplate(ctx: Pick<ProjectCtx, 'kind'>): void {
    if (ctx.kind === 'TEMPLATE')
      throw new ConflictProblem('E_TEMPLATE_NO_TABLES', API_ERROR_CODES.E_TEMPLATE_NO_TABLES);
  }

  private async dialectOf(q: ExecQ, projectId: number): Promise<Dialect> {
    const [p] = await rowsOf<{ default_dialect: Dialect }>(
      q,
      sql`select default_dialect from tf_project where project_id = ${projectId}`,
    );
    return p?.default_dialect ?? 'POSTGRESQL';
  }

  /**
   * 본문의 참조가 이 프로젝트 소속인지(§9.1 "본문·쿼리의 모든 ID", CR-01-3). 업무구분은 사용 중인 것만
   * (현재 업무구분을 유지하는 경우는 사용 중지돼도 허용 — §4.2 "사용 중지 업무구분의 자산은 계속 쓰인다").
   */
  async checkRefs(
    q: ExecQ,
    projectId: number,
    input: TableCreateInput,
    currentBizAreaId: number | null,
  ): Promise<ValidationIssue[]> {
    const out: ValidationIssue[] = [];
    const bizId = input.table.bizAreaId;
    if (bizId !== null) {
      const [b] = await rowsOf<{ use_yn: boolean }>(
        q,
        sql`select use_yn from prj_biz_area where project_id = ${projectId} and biz_area_id = ${bizId}`,
      );
      if (!b) {
        out.push({
          code: 'E_BIZ_AREA_NOT_FOUND',
          target: 'table',
          field: 'bizAreaId',
          message: API_ERROR_CODES.E_BIZ_AREA_NOT_FOUND,
        });
      } else if (!b.use_yn && bizId !== currentBizAreaId) {
        out.push({
          code: 'E_BIZ_AREA_INACTIVE',
          target: 'table',
          field: 'bizAreaId',
          message: '사용 중지된 업무구분에는 테이블을 만들거나 옮길 수 없습니다',
        });
      }
    }
    const [dom, cc, dc] = await refSets(q, projectId, input.columns);
    const checks = [
      ['domainId', dom, 'E_DOMAIN_NOT_FOUND'],
      ['codeClsId', cc, 'E_CODE_CLS_NOT_FOUND'],
      ['defaultColId', dc, 'E_DEFAULT_COL_NOT_FOUND'],
    ] as const;
    input.columns.forEach((c, i) => {
      for (const [f, set, code] of checks) {
        const v = c[f];
        if (v !== null && !set.has(v)) {
          out.push({
            code,
            target: 'column',
            rowIndex: i,
            columnId: c.columnId,
            ...(c.physicalNm ? { columnNm: c.physicalNm } : {}),
            field: f,
            message: API_ERROR_CODES[code],
          });
        }
      }
    });
    return out;
  }

  /** 정규화 → 참조 소속 → TableValidator(기본 방언, 다른 테이블명·접미어 포함, §5.7). */
  async check(
    q: ExecQ,
    projectId: number,
    raw: TableCreateInput,
    opts: {
      selfId?: number | undefined;
      currentBizAreaId?: number | null;
      /** DB에서 읽은 컬럼(참조는 복합 FK로 이미 같은 프로젝트) — 소속 검사 생략(편집기 로드 성능, §12.1). */
      trustedRefs?: boolean;
    } = {},
  ): Promise<Checked> {
    const input = normalizeInput(raw);
    const [refErrors, bizAreas, suffixes, names, dialect, cached] = await Promise.all([
      opts.trustedRefs
        ? Promise.resolve([] as ValidationIssue[])
        : this.checkRefs(q, projectId, input, opts.currentBizAreaId ?? null),
      loadBizAreas(q, projectId),
      loadSuffixes(q, projectId),
      rowsOf<{ table_nm: string }>(
        q,
        opts.selfId !== undefined
          ? sql`select table_nm from prj_table where project_id = ${projectId} and table_id <> ${opts.selfId}`
          : sql`select table_nm from prj_table where project_id = ${projectId}`,
      ),
      this.dialectOf(q, projectId),
      this.cache.get(projectId),
    ]);
    const model = await draftModel(q, projectId, input, bizAreas);
    const v = validateTable(model, {
      dialect,
      suffixes,
      otherTableNames: new Set(names.map((n) => n.table_nm)),
      // 재검증 힌트(§4.8, T9.9): 조각 중 검토대기·반려 용어, 재분절 물리명(W_TERM_CHANGED) — 캐시 스냅샷 기준
      termHints: (c) => columnTermHint(cached.snapshot, c),
    });
    const bizBad = refErrors.some((e) => e.target === 'table');
    return {
      input,
      errors: [
        ...refErrors,
        ...v.errors.filter((e) => !(bizBad && e.code === 'E_BIZ_AREA_REQUIRED')),
      ],
      warnings: v.warnings,
    };
  }

  private rejectErrors(c: Checked): void {
    if (c.errors.length > 0) throw new ValidationProblem(c.errors, c.warnings);
  }

  private async header(q: ExecQ, ctx: ProjectCtx, id: number): Promise<TableHeaderItem> {
    const h = await loadHeader(q, ctx.projectId, ctx.projectKey, id);
    if (!h) throw new NotFoundProblem('테이블을 찾을 수 없습니다');
    return h;
  }

  /** 409 version-conflict(§8.1): 최신본 전체를 본문 `current`로 준다(편집기가 재조회 없이 병합 모달을 연다). */
  private async conflict(ctx: ProjectCtx, id: number, yourVersion: number): Promise<never> {
    const table = await this.header(this.db, ctx, id);
    const columns = await loadColumns(this.db, ctx.projectId, id);
    const savedBy = table.updatedByNm ?? table.updatedBy;
    const savedAt = table.updatedAt;
    throw new ConflictProblem(
      'E_VERSION_CONFLICT',
      `${savedBy}이(가) ${savedAt.slice(11)}에 저장했습니다.`,
      { yourVersion, currentVersion: table.version, savedBy, savedAt, current: { table, columns } },
    );
  }

  async writeHistory(
    tx: Tx,
    ctx: ProjectCtx,
    tableId: number,
    meta: {
      action: HistoryAction;
      changeSummary: string;
      extra?: Pick<TableSnapshot, 'clonedFrom' | 'restoredFrom' | 'note'>;
    },
    a: Audit,
  ): Promise<{ header: TableHeaderItem; columns: Awaited<ReturnType<typeof loadColumns>> }> {
    const header = await this.header(tx, ctx, tableId);
    const columns = await loadColumns(tx, ctx.projectId, tableId);
    const snapshot = buildSnapshot(header, columns, {
      action: meta.action,
      changeSummary: meta.changeSummary,
      savedBy: a.actor,
      ...(meta.extra ? { extra: meta.extra } : {}),
    });
    await tx.insert(prjTableHistory).values({
      tableId,
      version: header.version,
      action: meta.action,
      changeSummary: meta.changeSummary.slice(0, 500),
      snapshot,
      savedBy: a.actor,
      savedIp: a.ip,
    });
    return { header, columns };
  }

  /** diff 계획 실행: 삭제 → 수정·순서 → 신규(uk(table_id,col_seq)·uk(table_id,physical_nm)는 DEFERRABLE, 커밋 시 검사). */
  async applyColumns(
    tx: Tx,
    projectId: number,
    tableId: number,
    plan: DiffPlan,
    a: Audit,
  ): Promise<void> {
    if (plan.deletes.length > 0) {
      await tx
        .delete(prjColumn)
        .where(and(eq(prjColumn.tableId, tableId), inArray(prjColumn.columnId, plan.deletes)));
    }
    const inserts: { input: IncomingColumn; seq: number }[] = [];
    for (const op of plan.ops) {
      if (op.kind === 'update') {
        await updateAudited(tx, prjColumn, colValues(op.input, op.seq), a).where(
          and(eq(prjColumn.columnId, op.columnId), eq(prjColumn.tableId, tableId)),
        );
      } else if (op.kind === 'reseq') {
        // 순서만 변경: 감사 컬럼 미갱신(§8.2)
        await tx
          .update(prjColumn)
          .set({ colSeq: op.seq })
          .where(and(eq(prjColumn.columnId, op.columnId), eq(prjColumn.tableId, tableId)));
      } else if (op.kind === 'insert') {
        inserts.push({ input: op.input, seq: op.seq });
      }
    }
    if (inserts.length > 0) {
      await insertAudited(
        tx,
        prjColumn,
        inserts.map((x) => ({ projectId, tableId, ...colValues(x.input, x.seq) })),
        a,
      );
    }
  }

  // ── 조회 ──────────────────────────────────────────────────────────
  /** GET P/tables/{id} — 테이블 + 컬럼 + 재검증(E·W, DDL과 같은 규칙). */
  async detail(ctx: ProjectCtx, id: number): Promise<TableDetail> {
    const [table, columns] = await Promise.all([
      this.header(this.db, ctx, id),
      loadColumns(this.db, ctx.projectId, id),
    ]);
    const c = await this.check(
      this.db,
      ctx.projectId,
      { table: table, columns },
      { selfId: id, currentBizAreaId: table.bizAreaId, trustedRefs: true },
    );
    return { table, columns, errors: c.errors, warnings: c.warnings };
  }

  /** POST P/tables/validate — 저장과 같은 정규화·검증(기록 없음). */
  async validate(
    ctx: ProjectCtx,
    input: TableCreateInput & { tableId?: number | undefined },
  ): Promise<TableValidateResponse> {
    let currentBiz: number | null = null;
    if (input.tableId !== undefined) {
      const [r] = await rowsOf<{ biz_area_id: number }>(
        this.db,
        sql`select biz_area_id from prj_table where project_id = ${ctx.projectId} and table_id = ${input.tableId}`,
      );
      if (!r) throw new NotFoundProblem('테이블을 찾을 수 없습니다');
      currentBiz = r.biz_area_id;
    }
    const c = await this.check(this.db, ctx.projectId, input, {
      selfId: input.tableId,
      currentBizAreaId: currentBiz,
    });
    return { errors: c.errors, warnings: c.warnings };
  }

  // ── 생성 ──────────────────────────────────────────────────────────
  /** POST P/tables — DRAFT·version 1·이력 CREATE(§8.4). */
  async create(ctx: ProjectCtx, raw: TableCreateInput, a: Audit): Promise<TableSaveResponse> {
    this.assertNotTemplate(ctx);
    const r = await this.db.transaction(async (tx) => {
      const c = await this.check(tx, ctx.projectId, raw);
      this.rejectErrors(c);
      const [t] = await insertAudited(
        tx,
        prjTable,
        {
          projectId: ctx.projectId,
          bizAreaId: c.input.table.bizAreaId!,
          tableNm: c.input.table.tableNm,
          tableLogicalNm: c.input.table.tableLogicalNm,
          description: c.input.table.description,
          status: 'DRAFT',
          version: 1,
        },
        a,
      ).returning({ tableId: prjTable.tableId });
      const tableId = t!.tableId;
      const plan = planColumnDiff([], c.input.columns);
      await this.applyColumns(tx, ctx.projectId, tableId, plan, a);
      const summary = `테이블 생성 · 컬럼 ${c.input.columns.length}`;
      const h = await this.writeHistory(
        tx,
        ctx,
        tableId,
        { action: 'CREATE', changeSummary: summary },
        a,
      );
      return { h, summary, warnings: c.warnings };
    });
    this.logger.log(`테이블 생성: ${ctx.projectKey} ${r.h.header.tableNm} by ${a.actor}`);
    return {
      tableId: r.h.header.tableId,
      version: r.h.header.version,
      status: r.h.header.status,
      columns: r.h.columns.map((x) => ({ columnId: x.columnId, colSeq: x.colSeq })),
      changeSummary: r.summary,
      warnings: r.warnings,
    };
  }

  // ── 저장(PUT) ────────────────────────────────────────────────────
  /**
   * PUT P/tables/{id}(§8.1·§8.2): FINAL 409 → version 불일치 409(current 포함) → 검증 422 → 조건부 UPDATE(version+1)
   * → 컬럼 diff → 스냅샷. 덮어쓰기는 클라이언트가 409의 currentVersion으로 같은 PUT을 다시 보내는 것(별도 플래그 없음).
   */
  async save(
    ctx: ProjectCtx,
    id: number,
    raw: TableCreateInput & { version: number },
    a: Audit,
    mode: SaveMode = { action: 'UPDATE' },
  ): Promise<TableSaveResponse> {
    this.assertNotTemplate(ctx);
    const r = await this.db.transaction(async (tx) => {
      const cur = await this.header(tx, ctx, id);
      if (cur.status === 'FINAL')
        throw new ConflictProblem('E_TABLE_FINAL', VALIDATION_CODES.E_TABLE_FINAL.message);
      if (cur.version !== raw.version) return { conflict: true as const };
      const c = await this.check(tx, ctx.projectId, raw, {
        selfId: id,
        currentBizAreaId: cur.bizAreaId,
      });
      this.rejectErrors(c);
      const t = c.input.table;
      const [u] = await updateAudited(
        tx,
        prjTable,
        {
          bizAreaId: t.bizAreaId!,
          tableNm: t.tableNm,
          tableLogicalNm: t.tableLogicalNm,
          description: t.description,
          version: sql`${prjTable.version} + 1`,
        },
        a,
      )
        .where(
          and(
            eq(prjTable.tableId, id),
            eq(prjTable.projectId, ctx.projectId),
            eq(prjTable.version, raw.version),
          ),
        )
        .returning({ version: prjTable.version });
      if (!u) return { conflict: true as const };
      const existing = (await loadColumns(tx, ctx.projectId, id)).map(toExisting);
      const plan = planColumnDiff(existing, c.input.columns);
      await this.applyColumns(tx, ctx.projectId, id, plan, a);
      const headerChanged =
        t.bizAreaId !== cur.bizAreaId ||
        t.tableNm !== cur.tableNm ||
        t.tableLogicalNm !== cur.tableLogicalNm ||
        t.description !== cur.description;
      const diffText = changeSummaryText(plan.summary, headerChanged);
      const summary = mode.summaryPrefix ? `${mode.summaryPrefix} · ${diffText}` : diffText;
      const h = await this.writeHistory(
        tx,
        ctx,
        id,
        {
          action: mode.action,
          changeSummary: summary,
          ...(mode.extra ? { extra: mode.extra } : {}),
        },
        a,
      );
      return { conflict: false as const, h, summary, warnings: c.warnings };
    });
    if (r.conflict) return this.conflict(ctx, id, raw.version);
    return {
      tableId: id,
      version: r.h.header.version,
      status: r.h.header.status,
      columns: r.h.columns.map((x) => ({ columnId: x.columnId, colSeq: x.colSeq })),
      changeSummary: r.summary,
      warnings: r.warnings,
    };
  }

  // ── 삭제 ──────────────────────────────────────────────────────────
  /** DELETE P/tables/{id}: DRAFT 편집자 / FINAL 프로젝트 관리자(§8.4). 컬럼·이력 CASCADE. */
  async remove(ctx: ProjectCtx, id: number, a: Audit): Promise<void> {
    this.assertNotTemplate(ctx);
    const cur = await this.header(this.db, ctx, id);
    if (cur.status === 'FINAL' && MEMBER_ROLE_RANK[ctx.role] < MEMBER_ROLE_RANK.ADMIN)
      throw new ForbiddenProblem('확정(FINAL) 테이블은 프로젝트 관리자만 삭제할 수 있습니다');
    await this.db
      .delete(prjTable)
      .where(and(eq(prjTable.tableId, id), eq(prjTable.projectId, ctx.projectId)));
    this.logger.log(`테이블 삭제: ${ctx.projectKey} ${cur.tableNm}(${cur.status}) by ${a.actor}`);
  }

  // ── 상태 전이 ────────────────────────────────────────────────────
  /**
   * PUT P/tables/{id}/status(§8.4): DRAFT→FINAL 편집자·E 0건(W 허용) · FINAL→DRAFT 프로젝트 관리자(사유 선택).
   * 둘 다 version+1·이력(FINALIZE/UNFINALIZE). 같은 상태로의 전이는 409 `E_TABLE_STATUS_INVALID`.
   */
  async setStatus(
    ctx: ProjectCtx,
    id: number,
    input: { status: TableStatus; version: number; note: string | null },
    a: Audit,
  ): Promise<TableStatusResponse> {
    this.assertNotTemplate(ctx);
    if (input.status === 'DRAFT' && MEMBER_ROLE_RANK[ctx.role] < MEMBER_ROLE_RANK.ADMIN)
      throw new ForbiddenProblem('확정 해제는 프로젝트 관리자만 할 수 있습니다');
    const r = await this.db.transaction(async (tx) => {
      const cur = await this.header(tx, ctx, id);
      if (cur.status === input.status) {
        throw new ConflictProblem('E_TABLE_STATUS_INVALID', `이미 ${input.status} 상태입니다`, {
          currentStatus: cur.status,
        });
      }
      if (cur.version !== input.version) return { conflict: true as const };
      if (input.status === 'FINAL') {
        const columns = await loadColumns(tx, ctx.projectId, id);
        const c = await this.check(
          tx,
          ctx.projectId,
          { table: cur, columns },
          { selfId: id, currentBizAreaId: cur.bizAreaId },
        );
        if (c.errors.length > 0) {
          throw new ValidationProblem(
            c.errors,
            c.warnings,
            `오류 ${c.errors.length}건이 있어 확정할 수 없습니다`,
          );
        }
      }
      const finalize = input.status === 'FINAL';
      const [u] = await updateAudited(
        tx,
        prjTable,
        {
          status: input.status,
          finalizedAt: finalize ? sql`CURRENT_TIMESTAMP` : null,
          finalizedBy: finalize ? a.actor : null,
          version: sql`${prjTable.version} + 1`,
        },
        a,
      )
        .where(
          and(
            eq(prjTable.tableId, id),
            eq(prjTable.projectId, ctx.projectId),
            eq(prjTable.version, input.version),
          ),
        )
        .returning({ version: prjTable.version });
      if (!u) return { conflict: true as const };
      const summary = finalize
        ? `확정(FINAL)${input.note ? `: ${input.note}` : ''}`
        : `확정 해제(DRAFT)${input.note ? `: ${input.note}` : ''}`;
      const h = await this.writeHistory(
        tx,
        ctx,
        id,
        {
          action: finalize ? 'FINALIZE' : 'UNFINALIZE',
          changeSummary: summary,
          extra: { note: input.note },
        },
        a,
      );
      return { conflict: false as const, header: h.header };
    });
    if (r.conflict) return this.conflict(ctx, id, input.version);
    this.logger.log(
      `테이블 상태: ${ctx.projectKey} ${r.header.tableNm} → ${input.status} by ${a.actor}`,
    );
    return {
      tableId: id,
      version: r.header.version,
      status: r.header.status,
      finalizedAt: r.header.finalizedAt,
      finalizedBy: r.header.finalizedBy,
    };
  }

  // ── 이력 ──────────────────────────────────────────────────────────
  async history(ctx: ProjectCtx, id: number): Promise<TableHistoryItem[]> {
    await this.header(this.db, ctx, id);
    const rows = await rowsOf<{
      version: number;
      action: HistoryAction;
      change_summary: string | null;
      saved_by: string;
      saved_by_nm: string | null;
      saved_at: string;
    }>(
      this.db,
      sql`select h.version, h.action, h.change_summary, h.saved_by, u.user_nm saved_by_nm,
                 to_char(h.saved_at, 'YYYY-MM-DD"T"HH24:MI:SS') saved_at
            from prj_table_history h left join tf_user u on u.login_id = h.saved_by
           where h.table_id = ${id}
           order by h.version desc`,
    );
    return rows.map((r) => ({
      version: r.version,
      action: r.action,
      changeSummary: r.change_summary,
      savedBy: r.saved_by,
      savedByNm: r.saved_by_nm,
      savedAt: r.saved_at,
    }));
  }

  async historyVersion(ctx: ProjectCtx, id: number, version: number): Promise<TableHistoryDetail> {
    await this.header(this.db, ctx, id);
    const [r] = await rowsOf<{
      version: number;
      action: HistoryAction;
      change_summary: string | null;
      saved_by: string;
      saved_by_nm: string | null;
      saved_at: string;
      snapshot: unknown;
    }>(
      this.db,
      sql`select h.version, h.action, h.change_summary, h.saved_by, u.user_nm saved_by_nm,
                 to_char(h.saved_at, 'YYYY-MM-DD"T"HH24:MI:SS') saved_at, h.snapshot
            from prj_table_history h left join tf_user u on u.login_id = h.saved_by
           where h.table_id = ${id} and h.version = ${version}`,
    );
    if (!r) throw new NotFoundProblem(`v${version} 이력이 없습니다`);
    return {
      version: r.version,
      action: r.action,
      changeSummary: r.change_summary,
      savedBy: r.saved_by,
      savedByNm: r.saved_by_nm,
      savedAt: r.saved_at,
      snapshot: readSnapshot(r.snapshot),
    };
  }

  /**
   * POST …/history/{v}/restore {version: 현재}(§8.3): 스냅샷의 헤더·컬럼을 저장 경로(diff)의 incoming으로 쓴다 — columnId가
   * 아직 있으면 유지, 없으면 신규. 새 version(현재+1)·action RESTORE·"v{n} 복원"(선형 이력). 그 사이 삭제된 도메인·코드구분·
   * 기본컬럼 참조는 연결 없음(NULL)으로, 없어진 업무구분은 현재 업무구분으로 둔다(CR-07 C6).
   */
  async restore(
    ctx: ProjectCtx,
    id: number,
    version: number,
    currentVersion: number,
    a: Audit,
  ): Promise<TableSaveResponse> {
    this.assertNotTemplate(ctx);
    const snap = (await this.historyVersion(ctx, id, version)).snapshot;
    const cur = await this.header(this.db, ctx, id);
    if (cur.status === 'FINAL')
      throw new ConflictProblem('E_TABLE_FINAL', '확정 테이블은 복원할 수 없습니다');
    const [[dom, cc, dc], biz] = await Promise.all([
      refSets(this.db, ctx.projectId, snap.columns),
      rowsOf<{ biz_area_id: number }>(
        this.db,
        sql`select biz_area_id from prj_biz_area where project_id = ${ctx.projectId} and biz_area_id = ${snap.table.bizAreaId}`,
      ),
    ]);
    const keep = (v: number | null, set: Set<number>) => (v !== null && set.has(v) ? v : null);
    return this.save(
      ctx,
      id,
      {
        version: currentVersion,
        table: {
          bizAreaId: biz.length > 0 ? snap.table.bizAreaId : cur.bizAreaId,
          tableNm: snap.table.tableNm,
          tableLogicalNm: snap.table.tableLogicalNm,
          description: snap.table.description,
        },
        columns: snap.columns.map((c) => ({
          columnId: c.columnId,
          logicalNm: c.logicalNm,
          physicalNm: c.physicalNm,
          isPk: c.isPk,
          dataType: c.dataType,
          dataLength: c.dataLength,
          dataScale: c.dataScale,
          isNullable: c.isNullable,
          defaultVal: c.defaultVal,
          colComment: c.colComment,
          domainId: keep(c.domainId, dom),
          codeClsId: keep(c.codeClsId, cc),
          defaultColId: keep(c.defaultColId, dc),
          matchType: c.matchType,
        })),
      },
      a,
      { action: 'RESTORE', summaryPrefix: `v${version} 복원`, extra: { restoredFrom: version } },
    );
  }
}
