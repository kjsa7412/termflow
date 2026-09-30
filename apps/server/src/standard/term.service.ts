import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import {
  API_ERROR_CODES,
  normalizeAbbr,
  normalizeTermKor,
  STD_WARNING_CODES,
  validateTermFields,
  type TermCheckResponse,
  type TermDetail,
  type TermInlineResponse,
  type TermInput,
  type TermItem,
  type TermListQuery,
  type TermPage,
  type TermRef,
  type TermSaveResponse,
  type TermStatus,
  type ValidationIssue,
} from '@termflow/shared';
import type { Audit } from '../common/audit/audit.js';
import { ConflictProblem, NotFoundProblem } from '../common/problem/problem.exception.js';
import type { ProjectCtx } from '../common/project-context.js';
import { insertAudited, updateAudited } from '../db/audit.js';
import type { Db } from '../db/client.js';
import { DRIZZLE } from '../db/db.module.js';
import { stdTerm } from '../db/schema.js';
import { auditJson, writeStdAudit } from './std-audit.js';
import {
  isoTs,
  likePattern,
  limitOffset,
  orderBy,
  rowsOf,
  throwIfErrors,
  whereAll,
  type ExecQ,
} from './std-sql.js';
import { StdWriter } from './std-write.js';

interface TermRow {
  term_id: number;
  term_kor: string;
  term_physical: string | null;
  description: string | null;
  synonym_ref: string | null;
  status: TermStatus;
  review_yn: boolean;
  review_note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  shared_cnt: number;
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
}

/** 목록·상세 공통 SELECT 절(별칭 t = std_term). */
export const TERM_COLUMNS = sql`t.term_id, t.term_kor, t.term_physical, t.description, t.synonym_ref, t.status,
  t.review_yn, t.review_note, t.reviewed_by, ${isoTs(sql`t.reviewed_at`)} reviewed_at,
  (select count(*) from std_term o where o.project_id = t.project_id and o.term_physical = t.term_physical
      and o.term_id <> t.term_id)::int shared_cnt,
  t.created_by, ${isoTs(sql`t.created_at`)} created_at, t.updated_by, ${isoTs(sql`t.updated_at`)} updated_at`;

export function mapTerm(r: TermRow): TermItem {
  return {
    termId: r.term_id,
    termKor: r.term_kor,
    termPhysical: r.term_physical,
    description: r.description,
    synonymRef: r.synonym_ref,
    status: r.status,
    reviewYn: r.review_yn,
    reviewNote: r.review_note,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
    sharedCnt: r.shared_cnt,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  };
}

const SORTS = {
  termKor: sql`t.term_kor collate "C"`,
  termPhysical: sql`t.term_physical collate "C"`,
  status: sql`t.status`,
  createdAt: sql`t.created_at`,
  updatedAt: sql`t.updated_at`,
} as const;

/** 물리약어를 공유하는 용어(R8): 프로젝트의 중복 물리약어 집합(해시 서브플랜 1회)으로 판정 — 행마다 상관 서브쿼리를 돌리지 않는다. */
const sharedCond = (
  projectId: number,
) => sql`t.term_physical in (select s.term_physical from std_term s
  where s.project_id = ${projectId} and s.term_physical is not null group by s.term_physical having count(*) > 1)`;

/** 같은 물리약어를 쓰는 다른 용어(R8 — 허용하되 경고). */
export async function physicalUsers(
  q: ExecQ,
  projectId: number,
  physical: string | null,
  exceptId?: number,
): Promise<TermRef[]> {
  if (!physical) return [];
  const rows = await rowsOf<{
    term_id: number;
    term_kor: string;
    term_physical: string;
    status: TermStatus;
  }>(
    q,
    sql`select term_id, term_kor, term_physical, status from std_term
         where project_id = ${projectId} and term_physical = ${physical}
           ${exceptId !== undefined ? sql`and term_id <> ${exceptId}` : sql``}
         order by term_kor collate "C" limit 20`,
  );
  return rows.map((r) => ({
    termId: r.term_id,
    termKor: r.term_kor,
    termPhysical: r.term_physical,
    status: r.status,
  }));
}

export function sharedWarning(conflicts: TermRef[], physical: string | null): ValidationIssue[] {
  if (conflicts.length === 0 || !physical) return [];
  return [
    {
      code: 'W_TERM_PHYSICAL_SHARED',
      target: 'field',
      field: 'termPhysical',
      message: `${STD_WARNING_CODES.W_TERM_PHYSICAL_SHARED}: ${physical} = ${conflicts
        .map((c) => c.termKor)
        .join(', ')}`,
    },
  ];
}

/**
 * 용어(T6.2, 설계서 §3.5.5·§4.5·§9.3). 프로젝트 관리자 등록은 APPROVED(§4.5 "(신규) → APPROVED").
 * 한글 중복 409 `E_TERM_DUP`, 물리약어 형식 422 `E_TERM_PHYSICAL_FORMAT`, 같은 물리약어는 경고(R8 `W_TERM_PHYSICAL_SHARED`).
 */
@Injectable()
export class TermService {
  private readonly logger = new Logger('Terms');

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly writer: StdWriter,
  ) {}

  async list(ctx: ProjectCtx, q: TermListQuery): Promise<TermPage> {
    const pid = ctx.projectId;
    const search = q.q
      ? sql`(t.term_kor ilike ${likePattern(q.q)} or t.term_physical ilike ${likePattern(q.q)})`
      : undefined;
    const base = [sql`t.project_id = ${pid}`, search, q.shared ? sharedCond(pid) : undefined];
    const where = whereAll([
      ...base,
      q.status ? sql`t.status = ${q.status}` : undefined,
      q.review === undefined ? undefined : sql`t.review_yn = ${q.review}`,
    ]);
    const countBase = whereAll([sql`t.project_id = ${pid}`, search]);
    const [rows, [cnt], [counts], [shared]] = await Promise.all([
      rowsOf<TermRow>(
        this.db,
        sql`select ${TERM_COLUMNS} from std_term t where ${where}
            order by ${orderBy(q.sort, SORTS, sql`t.term_kor collate "C" asc`, sql`t.term_id asc`)} ${limitOffset(q)}`,
      ),
      rowsOf<{ n: number }>(this.db, sql`select count(*)::int n from std_term t where ${where}`),
      rowsOf<Omit<TermPage['counts'], 'shared'>>(
        this.db,
        sql`select count(*)::int "all",
                   count(*) filter (where t.status = 'APPROVED')::int approved,
                   count(*) filter (where t.status = 'PENDING')::int pending,
                   count(*) filter (where t.status = 'REJECTED')::int rejected
              from std_term t where ${countBase}`,
      ),
      rowsOf<{ n: number }>(
        this.db,
        sql`select count(*)::int n from std_term t where ${countBase} and ${sharedCond(pid)}`,
      ),
    ]);
    return {
      items: rows.map(mapTerm),
      page: q.page,
      size: q.size,
      total: cnt?.n ?? 0,
      counts: {
        ...(counts ?? { all: 0, approved: 0, pending: 0, rejected: 0 }),
        shared: shared?.n ?? 0,
      },
    };
  }

  async item(q: ExecQ, projectId: number, termId: number): Promise<TermItem> {
    const [r] = await rowsOf<TermRow>(
      q,
      sql`select ${TERM_COLUMNS} from std_term t where t.project_id = ${projectId} and t.term_id = ${termId}`,
    );
    if (!r) throw new NotFoundProblem('용어를 찾을 수 없습니다');
    return mapTerm(r);
  }

  async detail(ctx: ProjectCtx, termId: number): Promise<TermDetail> {
    const term = await this.item(this.db, ctx.projectId, termId);
    const [conflicts, [d]] = await Promise.all([
      physicalUsers(this.db, ctx.projectId, term.termPhysical, termId),
      rowsOf<{ n: number }>(
        this.db,
        sql`select count(*)::int n from std_domain
             where project_id = ${ctx.projectId}
               and ${term.termKor} in (upper(nm1), upper(nm2), upper(nm3), upper(nm4), upper(nm5), upper(nm6), upper(nm7))`,
      ),
    ]);
    return { term, physicalConflicts: conflicts, domainCnt: d?.n ?? 0 };
  }

  async check(
    ctx: ProjectCtx,
    termKor: string | undefined,
    termPhysical: string | undefined,
    exceptId?: number,
  ): Promise<TermCheckResponse> {
    const kor = termKor ? normalizeTermKor(termKor) : '';
    let korTerm: TermRef | null = null;
    if (kor !== '') {
      const [r] = await this.db
        .select({
          termId: stdTerm.termId,
          termKor: stdTerm.termKor,
          termPhysical: stdTerm.termPhysical,
          status: stdTerm.status,
        })
        .from(stdTerm)
        .where(and(eq(stdTerm.projectId, ctx.projectId), eq(stdTerm.termKor, kor)));
      if (r && r.termId !== exceptId) korTerm = { ...r, status: r.status as TermStatus };
    }
    const phys = normalizeAbbr(termPhysical);
    return {
      korExists: korTerm !== null,
      korTerm,
      physicalUsedBy: await physicalUsers(this.db, ctx.projectId, phys, exceptId),
    };
  }

  /** 입력 정규화 + 형식 검사(422). */
  private normalize(input: TermInput): {
    termKor: string;
    termPhysical: string | null;
    description: string | null;
    synonymRef: string | null;
  } {
    const termKor = normalizeTermKor(input.termKor);
    const termPhysical = normalizeAbbr(input.termPhysical);
    throwIfErrors(validateTermFields(termKor, termPhysical));
    return {
      termKor,
      termPhysical,
      description: input.description,
      synonymRef: input.synonymRef,
    };
  }

  private dup(kor: string, termId?: number): ConflictProblem {
    return new ConflictProblem('E_TERM_DUP', `${API_ERROR_CODES.E_TERM_DUP}: ${kor}`, {
      termKor: kor,
      ...(termId !== undefined ? { termId } : {}),
    });
  }

  private async existingId(projectId: number, kor: string): Promise<number | undefined> {
    const [r] = await this.db
      .select({ id: stdTerm.termId })
      .from(stdTerm)
      .where(and(eq(stdTerm.projectId, projectId), eq(stdTerm.termKor, kor)));
    return r?.id;
  }

  async create(ctx: ProjectCtx, input: TermInput, a: Audit): Promise<TermSaveResponse> {
    this.writer.assertWritable(ctx);
    const v = this.normalize(input);
    const exists = await this.existingId(ctx.projectId, v.termKor);
    if (exists !== undefined) throw this.dup(v.termKor, exists);
    const id = await this.writer.write(ctx, async (tx) => {
      const [r] = await insertAudited(
        tx,
        stdTerm,
        { projectId: ctx.projectId, ...v, status: 'APPROVED' },
        a,
      )
        .onConflictDoNothing()
        .returning();
      if (!r) throw this.dup(v.termKor);
      await writeStdAudit(
        tx,
        {
          projectId: ctx.projectId,
          entityType: 'TERM',
          entityId: r.termId,
          action: 'INSERT',
          after: auditJson(r),
        },
        a,
      );
      return r.termId;
    });
    this.logger.log(`용어 등록: ${ctx.projectKey} ${v.termKor}=${v.termPhysical} by ${a.actor}`);
    return this.saved(ctx, id);
  }

  /**
   * 인라인 등록(편집기 미등록 카드, §4.5·§5.4·§5.9, T9.6). 경로 프로젝트에 **PENDING**으로 등록한다(편집자 이상).
   *  - 같은 한글 용어가 APPROVED·PENDING으로 이미 있으면 그 용어를 쓴다(쓰기 없음, outcome EXISTING).
   *  - REJECTED면 그 행을 PENDING으로 갱신(물리약어·설명 교체, 검토 정보 초기화, 감사 UPDATE, outcome REOPENED).
   *  - 같은 물리약어를 쓰는 다른 용어는 경고(`conflicts`)로만 알린다(R8). 쓰기는 StdWriter → 커밋 후 캐시 무효화.
   */
  async inline(
    ctx: ProjectCtx,
    input: { termKor: string; termPhysical: string; description: string | null },
    a: Audit,
  ): Promise<{ res: TermInlineResponse; written: boolean }> {
    this.writer.assertWritable(ctx);
    const v = this.normalize({ ...input, synonymRef: null });
    const [cur] = await this.db
      .select()
      .from(stdTerm)
      .where(and(eq(stdTerm.projectId, ctx.projectId), eq(stdTerm.termKor, v.termKor)));
    const respond = async (
      termId: number,
      outcome: TermInlineResponse['outcome'],
    ): Promise<TermInlineResponse> => {
      const term = await this.item(this.db, ctx.projectId, termId);
      const conflicts = await physicalUsers(this.db, ctx.projectId, term.termPhysical, termId);
      return {
        termId,
        status: term.status,
        outcome,
        termKor: term.termKor,
        termPhysical: term.termPhysical,
        conflicts: conflicts.map((c) => ({ termKor: c.termKor, termPhysical: c.termPhysical! })),
        warnings: sharedWarning(conflicts, term.termPhysical),
      };
    };
    if (cur && cur.status !== 'REJECTED') {
      return { res: await respond(cur.termId, 'EXISTING'), written: false };
    }
    if (cur) {
      await this.writer.write(
        ctx,
        async (tx) => {
          const [after] = await updateAudited(
            tx,
            stdTerm,
            {
              termPhysical: v.termPhysical,
              description: v.description,
              status: 'PENDING',
              reviewNote: null,
              reviewedBy: null,
              reviewedAt: null,
            },
            a,
          )
            .where(eq(stdTerm.termId, cur.termId))
            .returning();
          await writeStdAudit(
            tx,
            {
              projectId: ctx.projectId,
              entityType: 'TERM',
              entityId: cur.termId,
              action: 'UPDATE',
              before: auditJson(cur),
              after: auditJson(after),
            },
            a,
          );
        },
        { prefetch: true },
      );
      this.logger.log(`용어 재등록(반려 → 검토대기): ${ctx.projectKey} ${v.termKor} by ${a.actor}`);
      return { res: await respond(cur.termId, 'REOPENED'), written: true };
    }
    const id = await this.writer.write(
      ctx,
      async (tx) => {
        const [r] = await insertAudited(
          tx,
          stdTerm,
          { projectId: ctx.projectId, ...v, status: 'PENDING' },
          a,
        )
          .onConflictDoNothing()
          .returning();
        if (!r) throw this.dup(v.termKor);
        await writeStdAudit(
          tx,
          {
            projectId: ctx.projectId,
            entityType: 'TERM',
            entityId: r.termId,
            action: 'INSERT',
            after: auditJson(r),
          },
          a,
        );
        return r.termId;
      },
      { prefetch: true },
    );
    this.logger.log(
      `용어 인라인 등록(검토대기): ${ctx.projectKey} ${v.termKor}=${v.termPhysical} by ${a.actor}`,
    );
    return { res: await respond(id, 'CREATED'), written: true };
  }

  /** 수정(PUT = 전체 교체). 상태는 바꾸지 않는다(승인·반려는 승인 큐). */
  async update(
    ctx: ProjectCtx,
    termId: number,
    input: TermInput,
    a: Audit,
  ): Promise<TermSaveResponse> {
    this.writer.assertWritable(ctx);
    const v = this.normalize(input);
    const [cur] = await this.db
      .select()
      .from(stdTerm)
      .where(and(eq(stdTerm.projectId, ctx.projectId), eq(stdTerm.termId, termId)));
    if (!cur) throw new NotFoundProblem('용어를 찾을 수 없습니다');
    if (v.termKor !== cur.termKor) {
      const other = await this.existingId(ctx.projectId, v.termKor);
      if (other !== undefined) throw this.dup(v.termKor, other);
    }
    await this.writer.write(ctx, async (tx) => {
      const [after] = await updateAudited(tx, stdTerm, v, a)
        .where(eq(stdTerm.termId, termId))
        .returning();
      await writeStdAudit(
        tx,
        {
          projectId: ctx.projectId,
          entityType: 'TERM',
          entityId: termId,
          action: 'UPDATE',
          before: auditJson(cur),
          after: auditJson(after),
        },
        a,
      );
    });
    return this.saved(ctx, termId);
  }

  /** 삭제(§4.5: APPROVED·REJECTED → 삭제). 검토대기는 승인 큐에서 처리(409). */
  async remove(ctx: ProjectCtx, termId: number, a: Audit): Promise<void> {
    this.writer.assertWritable(ctx);
    const [cur] = await this.db
      .select()
      .from(stdTerm)
      .where(and(eq(stdTerm.projectId, ctx.projectId), eq(stdTerm.termId, termId)));
    if (!cur) throw new NotFoundProblem('용어를 찾을 수 없습니다');
    if (cur.status === 'PENDING') {
      throw new ConflictProblem('E_TERM_PENDING_DELETE', API_ERROR_CODES.E_TERM_PENDING_DELETE);
    }
    await this.writer.write(ctx, async (tx) => {
      await tx.delete(stdTerm).where(eq(stdTerm.termId, termId));
      await writeStdAudit(
        tx,
        {
          projectId: ctx.projectId,
          entityType: 'TERM',
          entityId: termId,
          action: 'DELETE',
          before: auditJson(cur),
        },
        a,
      );
    });
    this.logger.log(`용어 삭제: ${ctx.projectKey} ${cur.termKor} by ${a.actor}`);
  }

  private async saved(ctx: ProjectCtx, termId: number): Promise<TermSaveResponse> {
    const term = await this.item(this.db, ctx.projectId, termId);
    const conflicts = await physicalUsers(this.db, ctx.projectId, term.termPhysical, termId);
    return {
      term,
      physicalConflicts: conflicts,
      warnings: sharedWarning(conflicts, term.termPhysical),
    };
  }
}

/** 한글 용어가 들어 있는 컬럼 논리명(승인 큐 영향 추정). */
export function columnLike(kor: string): SQL {
  return sql`c.logical_nm like ${likePattern(kor)}`;
}
