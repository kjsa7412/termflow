import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  API_ERROR_CODES,
  normalizeAbbr,
  validateTermFields,
  type ApprovalBatchResponse,
  type ApprovalItem,
  type ApprovalPage,
  type PageQuery,
  type TermSaveResponse,
} from '@termflow/shared';
import type { Audit } from '../common/audit/audit.js';
import { ConflictProblem, NotFoundProblem } from '../common/problem/problem.exception.js';
import type { ProjectCtx } from '../common/project-context.js';
import { updateAudited } from '../db/audit.js';
import type { Db } from '../db/client.js';
import { DRIZZLE } from '../db/db.module.js';
import { stdTerm } from '../db/schema.js';
import { auditJson, writeStdAudit } from './std-audit.js';
import { likePattern, limitOffset, rowsOf, throwIfErrors } from './std-sql.js';
import { StdWriter } from './std-write.js';
import {
  mapTerm,
  physicalUsers,
  sharedWarning,
  TERM_COLUMNS,
  TermService,
} from './term.service.js';

/**
 * 승인 큐(T6.7, 설계서 §4.5, 목업 11) — 프로젝트 관리자. 상태 전이:
 *  PENDING → APPROVED(승인, 정정 후 승인: 물리약어·설명 변경 가능, audit APPROVE)
 *  PENDING → REJECTED(반려, 사유 필수 → review_note, audit REJECT)
 * 그 밖의 상태에서 승인·반려는 409 `E_TERM_NOT_PENDING`. 처리자·일시는 reviewed_by/at.
 */
@Injectable()
export class ApprovalService {
  private readonly logger = new Logger('Approvals');

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly writer: StdWriter,
    private readonly terms: TermService,
  ) {}

  async count(ctx: ProjectCtx): Promise<{ pending: number }> {
    const [r] = await rowsOf<{ n: number }>(
      this.db,
      sql`select count(*)::int n from std_term where project_id = ${ctx.projectId} and status = 'PENDING'`,
    );
    return { pending: r?.n ?? 0 };
  }

  async list(
    ctx: ProjectCtx,
    q: PageQuery & { state: 'PENDING' | 'PROCESSED' },
  ): Promise<ApprovalPage> {
    const pid = ctx.projectId;
    const where =
      q.state === 'PENDING'
        ? sql`t.project_id = ${pid} and t.status = 'PENDING'`
        : sql`t.project_id = ${pid} and t.status <> 'PENDING' and t.reviewed_at is not null`;
    // 검토대기: 등록 오래된 순(목업 11) · 처리 완료: 최근 처리순
    const order =
      q.state === 'PENDING'
        ? sql`t.created_at asc, t.term_id asc`
        : sql`t.reviewed_at desc, t.term_id desc`;
    const [rows, [cnt]] = await Promise.all([
      rowsOf<Parameters<typeof mapTerm>[0]>(
        this.db,
        sql`select ${TERM_COLUMNS} from std_term t where ${where} order by ${order} ${limitOffset(q)}`,
      ),
      rowsOf<{ pending: number; processed: number }>(
        this.db,
        sql`select count(*) filter (where status = 'PENDING')::int pending,
                   count(*) filter (where status <> 'PENDING' and reviewed_at is not null)::int processed
              from std_term where project_id = ${pid}`,
      ),
    ]);
    const items: ApprovalItem[] = [];
    for (const r of rows) {
      const term = mapTerm(r);
      const [conflicts, cols] = await Promise.all([
        physicalUsers(this.db, pid, term.termPhysical, term.termId),
        rowsOf<{ table_nm: string; logical_nm: string; n: number }>(
          this.db,
          sql`select t.table_nm, c.logical_nm, count(*) over ()::int n
                from prj_column c join prj_table t on t.table_id = c.table_id
               where c.project_id = ${pid} and c.logical_nm like ${likePattern(term.termKor)}
               order by t.table_nm, c.col_seq limit 3`,
        ),
      ]);
      items.push({
        ...term,
        physicalConflicts: conflicts,
        columnCnt: cols[0]?.n ?? 0,
        columnSamples: cols.map((c) => ({ tableNm: c.table_nm, logicalNm: c.logical_nm })),
      });
    }
    const total = q.state === 'PENDING' ? (cnt?.pending ?? 0) : (cnt?.processed ?? 0);
    return {
      items,
      page: q.page,
      size: q.size,
      total,
      counts: { pending: cnt?.pending ?? 0, processed: cnt?.processed ?? 0 },
    };
  }

  private async pendingRow(ctx: ProjectCtx, termId: number) {
    const [cur] = await this.db
      .select()
      .from(stdTerm)
      .where(and(eq(stdTerm.projectId, ctx.projectId), eq(stdTerm.termId, termId)));
    if (!cur) throw new NotFoundProblem('용어를 찾을 수 없습니다');
    if (cur.status !== 'PENDING') throw this.notPending([{ termId, status: cur.status }]);
    return cur;
  }

  private notPending(list: { termId: number; status: string }[]): ConflictProblem {
    return new ConflictProblem(
      'E_TERM_NOT_PENDING',
      `${API_ERROR_CODES.E_TERM_NOT_PENDING}(${list.map((x) => `${x.termId}:${x.status}`).join(', ')})`,
      { terms: list },
    );
  }

  /** 승인(정정 포함). 정정 값은 용어 등록과 같은 형식 검사(422). */
  async approve(
    ctx: ProjectCtx,
    termId: number,
    body: { termPhysical?: string | undefined; description?: string | null | undefined },
    a: Audit,
  ): Promise<TermSaveResponse> {
    this.writer.assertWritable(ctx);
    const cur = await this.pendingRow(ctx, termId);
    const physical =
      body.termPhysical !== undefined ? normalizeAbbr(body.termPhysical) : cur.termPhysical;
    throwIfErrors(validateTermFields(cur.termKor, physical));
    const corrected =
      physical !== cur.termPhysical ||
      (body.description !== undefined && body.description !== cur.description);
    await this.writer.write(ctx, async (tx) => {
      const [after] = await updateAudited(
        tx,
        stdTerm,
        {
          status: 'APPROVED',
          termPhysical: physical,
          ...(body.description !== undefined ? { description: body.description } : {}),
          reviewedBy: a.actor,
          reviewedAt: sql`CURRENT_TIMESTAMP`,
          reviewNote: null,
        },
        a,
      )
        .where(and(eq(stdTerm.termId, termId), eq(stdTerm.status, 'PENDING')))
        .returning();
      if (!after) throw this.notPending([{ termId, status: 'CHANGED' }]);
      await writeStdAudit(
        tx,
        {
          projectId: ctx.projectId,
          entityType: 'TERM',
          entityId: termId,
          action: 'APPROVE',
          before: auditJson(cur),
          after: { ...(auditJson(after) as object), corrected },
        },
        a,
      );
    });
    this.logger.log(
      `용어 승인${corrected ? '(정정)' : ''}: ${ctx.projectKey} ${cur.termKor}=${physical} by ${a.actor}`,
    );
    const term = await this.terms.item(this.db, ctx.projectId, termId);
    const conflicts = await physicalUsers(this.db, ctx.projectId, term.termPhysical, termId);
    return {
      term,
      physicalConflicts: conflicts,
      warnings: sharedWarning(conflicts, term.termPhysical),
    };
  }

  /** 반려(사유 필수 → review_note). 자동완성 대상에서 빠진다(§4.5). */
  async reject(ctx: ProjectCtx, termId: number, note: string, a: Audit): Promise<TermSaveResponse> {
    this.writer.assertWritable(ctx);
    const cur = await this.pendingRow(ctx, termId);
    await this.writer.write(ctx, async (tx) => {
      const [after] = await updateAudited(
        tx,
        stdTerm,
        {
          status: 'REJECTED',
          reviewNote: note,
          reviewedBy: a.actor,
          reviewedAt: sql`CURRENT_TIMESTAMP`,
        },
        a,
      )
        .where(and(eq(stdTerm.termId, termId), eq(stdTerm.status, 'PENDING')))
        .returning();
      if (!after) throw this.notPending([{ termId, status: 'CHANGED' }]);
      await writeStdAudit(
        tx,
        {
          projectId: ctx.projectId,
          entityType: 'TERM',
          entityId: termId,
          action: 'REJECT',
          before: auditJson(cur),
          after: auditJson(after),
        },
        a,
      );
    });
    this.logger.log(`용어 반려: ${ctx.projectKey} ${cur.termKor} by ${a.actor}`);
    const term = await this.terms.item(this.db, ctx.projectId, termId);
    return { term, physicalConflicts: [], warnings: [] };
  }

  /** 선택 승인(원안 그대로). 하나라도 검토대기가 아니면 전체 거부(409, 원자적). */
  async approveBatch(ctx: ProjectCtx, termIds: number[], a: Audit): Promise<ApprovalBatchResponse> {
    this.writer.assertWritable(ctx);
    const ids = [...new Set(termIds)];
    const rows = await this.db
      .select()
      .from(stdTerm)
      .where(and(eq(stdTerm.projectId, ctx.projectId), inArray(stdTerm.termId, ids)));
    if (rows.length !== ids.length) {
      const found = new Set(rows.map((r) => r.termId));
      throw new NotFoundProblem(
        `용어를 찾을 수 없습니다: ${ids.filter((i) => !found.has(i)).join(', ')}`,
      );
    }
    const bad = rows.filter((r) => r.status !== 'PENDING');
    if (bad.length > 0)
      throw this.notPending(bad.map((r) => ({ termId: r.termId, status: r.status })));
    for (const r of rows) throwIfErrors(validateTermFields(r.termKor, r.termPhysical));
    await this.writer.write(ctx, async (tx) => {
      const after = await updateAudited(
        tx,
        stdTerm,
        { status: 'APPROVED', reviewedBy: a.actor, reviewedAt: sql`CURRENT_TIMESTAMP` },
        a,
      )
        .where(and(inArray(stdTerm.termId, ids), eq(stdTerm.status, 'PENDING')))
        .returning();
      if (after.length !== ids.length) throw this.notPending([{ termId: 0, status: 'CHANGED' }]);
      const before = new Map(rows.map((r) => [r.termId, r]));
      await writeStdAudit(
        tx,
        after.map((r) => ({
          projectId: ctx.projectId,
          entityType: 'TERM' as const,
          entityId: r.termId,
          action: 'APPROVE' as const,
          before: auditJson(before.get(r.termId)),
          after: { ...(auditJson(r) as object), corrected: false },
        })),
        a,
      );
    });
    this.logger.log(`용어 선택 승인 ${ids.length}건: ${ctx.projectKey} by ${a.actor}`);
    return { approved: ids.length, termIds: ids };
  }
}
