import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  API_ERROR_CODES,
  checkStdTypeParts,
  normalizeAbbr,
  stdTypeProblemIssue,
  typeText,
  validateSuffix,
  type DomainClsDeleteResponse,
  type DomainClsInput,
  type DomainClsItem,
  type DomainClsListQuery,
  type DomainClsPage,
  type DomainClsSaveResponse,
  type StdType,
  type ValidationIssue,
} from '@termflow/shared';
import type { Audit } from '../common/audit/audit.js';
import { ConflictProblem, NotFoundProblem } from '../common/problem/problem.exception.js';
import type { ProjectCtx } from '../common/project-context.js';
import { insertAudited, updateAudited } from '../db/audit.js';
import type { Db } from '../db/client.js';
import { DRIZZLE } from '../db/db.module.js';
import { stdDomainCls } from '../db/schema.js';
import { auditJson, writeStdAudit } from './std-audit.js';
import {
  isoTs,
  likePattern,
  limitOffset,
  orderBy,
  rowsOf,
  throwIfErrors,
  whereAll,
} from './std-sql.js';
import { StdWriter } from './std-write.js';

interface ClsRow {
  domain_cls_id: number;
  suffix: string;
  cls_nm: string;
  col_type: StdType;
  col_length: number | null;
  col_scale: number | null;
  description: string | null;
  review_yn: boolean;
  domain_cnt: number;
  sample_logical: string | null;
  sample_physical: string | null;
  updated_by: string;
  updated_at: string;
}

const COLUMNS = sql`c.domain_cls_id, c.suffix, c.cls_nm, c.col_type, c.col_length, c.col_scale, c.description,
  c.review_yn,
  (select count(*) from std_domain d where d.project_id = c.project_id and d.domain_cls_id = c.domain_cls_id)::int domain_cnt,
  s.logical_nm sample_logical, s.physical_nm sample_physical,
  c.updated_by, ${isoTs(sql`c.updated_at`)} updated_at`;
const FROM = sql`std_domain_cls c
  left join lateral (select d.logical_nm, d.physical_nm from std_domain d
                      where d.project_id = c.project_id and d.domain_cls_id = c.domain_cls_id
                      order by d.review_yn, d.logical_nm limit 1) s on true`;

function mapCls(r: ClsRow): DomainClsItem {
  return {
    domainClsId: r.domain_cls_id,
    suffix: r.suffix,
    clsNm: r.cls_nm,
    colType: r.col_type,
    colLength: r.col_length,
    colScale: r.col_scale,
    typeText: typeText(r.col_type, r.col_length, r.col_scale) ?? r.col_type,
    description: r.description,
    reviewYn: r.review_yn,
    domainCnt: r.domain_cnt,
    sample: r.sample_logical
      ? { logicalNm: r.sample_logical, physicalNm: r.sample_physical }
      : null,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  };
}

const SORTS = {
  suffix: sql`c.suffix`,
  clsNm: sql`c.cls_nm`,
  colType: sql`c.col_type`,
  domainCnt: sql`domain_cnt`,
  updatedAt: sql`c.updated_at`,
} as const;

/** 도메인분류 입력 정규화·검사(API·일괄 등록 공용). 문제는 422 errors로. */
export function validateDomainCls(input: {
  suffix: string | null;
  colType: StdType;
  colLength: number | null;
  colScale: number | null;
}): ValidationIssue[] {
  const errors = validateSuffix(input.suffix);
  const p = checkStdTypeParts(input.colType, input.colLength, input.colScale);
  if (p)
    errors.push({ ...stdTypeProblemIssue(p, input.colType), target: 'field', field: 'colLength' });
  return errors;
}

/**
 * 도메인분류(T6.3, 설계서 §3.5.6). 접미어 중복 409 `E_DOMAIN_CLS_DUP`. 삭제는 사용 도메인이 있으면 409
 * `E_DOMAIN_CLS_IN_USE`(건수 포함) → `?force=true`로 확정하면 도메인의 분류 연결만 해제(SET NULL, 도메인 타입은 유지 — §4.8
 * "표준 변경은 설계물을 자동으로 고치지 않는다"). 길이 변경도 도메인을 바꾸지 않는다(재계산 명령으로만).
 */
@Injectable()
export class DomainClsService {
  private readonly logger = new Logger('DomainClasses');

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly writer: StdWriter,
  ) {}

  async list(ctx: ProjectCtx, q: DomainClsListQuery): Promise<DomainClsPage> {
    const pid = ctx.projectId;
    const search = q.q
      ? sql`(c.suffix ilike ${likePattern(q.q)} or c.cls_nm ilike ${likePattern(q.q)})`
      : undefined;
    const base = [sql`c.project_id = ${pid}`, search];
    const where = whereAll([
      ...base,
      q.colType ? sql`c.col_type = ${q.colType}` : undefined,
      q.review === undefined ? undefined : sql`c.review_yn = ${q.review}`,
    ]);
    const [rows, [cnt], [counts]] = await Promise.all([
      rowsOf<ClsRow>(
        this.db,
        sql`select ${COLUMNS} from ${FROM} where ${where}
            order by ${orderBy(q.sort, SORTS, sql`c.suffix asc`, sql`c.domain_cls_id asc`)} ${limitOffset(q)}`,
      ),
      rowsOf<{ n: number }>(
        this.db,
        sql`select count(*)::int n from std_domain_cls c where ${where}`,
      ),
      rowsOf<DomainClsPage['counts']>(
        this.db,
        sql`select count(*)::int "all", count(*) filter (where c.review_yn)::int review
              from std_domain_cls c where ${whereAll(base)}`,
      ),
    ]);
    return {
      items: rows.map(mapCls),
      page: q.page,
      size: q.size,
      total: cnt?.n ?? 0,
      counts: counts ?? { all: 0, review: 0 },
    };
  }

  async item(ctx: ProjectCtx, id: number): Promise<DomainClsItem> {
    const [r] = await rowsOf<ClsRow>(
      this.db,
      sql`select ${COLUMNS} from ${FROM} where c.project_id = ${ctx.projectId} and c.domain_cls_id = ${id}`,
    );
    if (!r) throw new NotFoundProblem('도메인분류를 찾을 수 없습니다');
    return mapCls(r);
  }

  private normalize(input: DomainClsInput) {
    const suffix = normalizeAbbr(input.suffix);
    throwIfErrors(validateDomainCls({ ...input, suffix }));
    return {
      suffix: suffix!,
      clsNm: input.clsNm,
      colType: input.colType,
      colLength: input.colLength,
      colScale: input.colScale,
      description: input.description,
    };
  }

  private async suffixOwner(projectId: number, suffix: string): Promise<number | undefined> {
    const [r] = await this.db
      .select({ id: stdDomainCls.domainClsId })
      .from(stdDomainCls)
      .where(and(eq(stdDomainCls.projectId, projectId), eq(stdDomainCls.suffix, suffix)));
    return r?.id;
  }

  private dup(suffix: string, id?: number): ConflictProblem {
    return new ConflictProblem(
      'E_DOMAIN_CLS_DUP',
      `${API_ERROR_CODES.E_DOMAIN_CLS_DUP}: ${suffix}`,
      {
        suffix,
        ...(id !== undefined ? { domainClsId: id } : {}),
      },
    );
  }

  async create(ctx: ProjectCtx, input: DomainClsInput, a: Audit): Promise<DomainClsSaveResponse> {
    this.writer.assertWritable(ctx);
    const v = this.normalize(input);
    const owner = await this.suffixOwner(ctx.projectId, v.suffix);
    if (owner !== undefined) throw this.dup(v.suffix, owner);
    const id = await this.writer.write(ctx, async (tx) => {
      const [r] = await insertAudited(tx, stdDomainCls, { projectId: ctx.projectId, ...v }, a)
        .onConflictDoNothing()
        .returning();
      if (!r) throw this.dup(v.suffix);
      await writeStdAudit(
        tx,
        {
          projectId: ctx.projectId,
          entityType: 'DOMAIN_CLS',
          entityId: r.domainClsId,
          action: 'INSERT',
          after: auditJson(r),
        },
        a,
      );
      return r.domainClsId;
    });
    this.logger.log(`도메인분류 등록: ${ctx.projectKey} ${v.suffix} by ${a.actor}`);
    return { domainCls: await this.item(ctx, id), warnings: await this.recalcHint(ctx, v.suffix) };
  }

  /** 수정. 접미어 변경은 연결된 도메인이 없을 때만(있으면 409 E_DOMAIN_CLS_IN_USE). 검토 표시는 저장하면 해제. */
  async update(
    ctx: ProjectCtx,
    id: number,
    input: DomainClsInput,
    a: Audit,
  ): Promise<DomainClsSaveResponse> {
    this.writer.assertWritable(ctx);
    const v = this.normalize(input);
    const [cur] = await this.db
      .select()
      .from(stdDomainCls)
      .where(and(eq(stdDomainCls.projectId, ctx.projectId), eq(stdDomainCls.domainClsId, id)));
    if (!cur) throw new NotFoundProblem('도메인분류를 찾을 수 없습니다');
    if (v.suffix !== cur.suffix) {
      const used = await this.domainCnt(ctx.projectId, id);
      if (used > 0)
        throw new ConflictProblem(
          'E_DOMAIN_CLS_IN_USE',
          `도메인 ${used}건이 접미어 ${cur.suffix}를 쓰고 있어 접미어를 바꿀 수 없습니다`,
          { domainCnt: used },
        );
      const owner = await this.suffixOwner(ctx.projectId, v.suffix);
      if (owner !== undefined) throw this.dup(v.suffix, owner);
    }
    await this.writer.write(ctx, async (tx) => {
      const [after] = await updateAudited(tx, stdDomainCls, { ...v, reviewYn: false }, a)
        .where(eq(stdDomainCls.domainClsId, id))
        .returning();
      await writeStdAudit(
        tx,
        {
          projectId: ctx.projectId,
          entityType: 'DOMAIN_CLS',
          entityId: id,
          action: 'UPDATE',
          before: auditJson(cur),
          after: auditJson(after),
        },
        a,
      );
    });
    const typeChanged =
      cur.colType !== v.colType || cur.colLength !== v.colLength || cur.colScale !== v.colScale;
    return {
      domainCls: await this.item(ctx, id),
      warnings: typeChanged ? await this.recalcHint(ctx, v.suffix) : [],
    };
  }

  async remove(
    ctx: ProjectCtx,
    id: number,
    force: boolean,
    a: Audit,
  ): Promise<DomainClsDeleteResponse> {
    this.writer.assertWritable(ctx);
    const [cur] = await this.db
      .select()
      .from(stdDomainCls)
      .where(and(eq(stdDomainCls.projectId, ctx.projectId), eq(stdDomainCls.domainClsId, id)));
    if (!cur) throw new NotFoundProblem('도메인분류를 찾을 수 없습니다');
    const used = await this.domainCnt(ctx.projectId, id);
    if (used > 0 && !force) {
      throw new ConflictProblem(
        'E_DOMAIN_CLS_IN_USE',
        `도메인 ${used}건이 접미어 ${cur.suffix}를 쓰고 있습니다. 삭제하면 도메인의 분류 연결이 해제됩니다(?force=true)`,
        { domainCnt: used },
      );
    }
    await this.writer.write(ctx, async (tx) => {
      await tx.delete(stdDomainCls).where(eq(stdDomainCls.domainClsId, id));
      await writeStdAudit(
        tx,
        {
          projectId: ctx.projectId,
          entityType: 'DOMAIN_CLS',
          entityId: id,
          action: 'DELETE',
          before: auditJson(cur),
          after: { unlinkedDomains: used },
        },
        a,
      );
    });
    this.logger.log(
      `도메인분류 삭제: ${ctx.projectKey} ${cur.suffix}(연결 해제 ${used}) by ${a.actor}`,
    );
    return { unlinkedDomains: used };
  }

  private async domainCnt(projectId: number, id: number): Promise<number> {
    const [r] = await rowsOf<{ n: number }>(
      this.db,
      sql`select count(*)::int n from std_domain where project_id = ${projectId} and domain_cls_id = ${id}`,
    );
    return r?.n ?? 0;
  }

  /** 등록·타입 변경 후 안내: 이 접미어로 재계산 대상이 되는 도메인 수(§4.8 재계산은 관리자 명령). */
  private async recalcHint(ctx: ProjectCtx, suffix: string): Promise<ValidationIssue[]> {
    const [r] = await rowsOf<{ review: number; auto: number }>(
      this.db,
      sql`select count(*) filter (where review_yn)::int review,
                 count(*) filter (where type_source = 'AUTO')::int auto
            from std_domain where project_id = ${ctx.projectId} and suffix = ${suffix}`,
    );
    if (!r || (r.review === 0 && r.auto === 0)) return [];
    return [
      {
        code: 'W_DOMAIN_RECALC_NEEDED',
        target: 'all',
        message: `접미어 ${suffix} 도메인 ${r.auto}건(검토필요 ${r.review}건)은 [재계산]을 실행해야 타입이 반영됩니다`,
      },
    ];
  }
}
