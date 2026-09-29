import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  API_ERROR_CODES,
  type CodeClsDeleteResponse,
  type CodeClsDetail,
  type CodeClsInput,
  type CodeClsItem,
  type CodeClsListQuery,
  type CodeInput,
  type CodeItem,
  type Page,
} from '@termflow/shared';
import type { Audit } from '../common/audit/audit.js';
import {
  ConflictProblem,
  NotFoundProblem,
  ValidationProblem,
} from '../common/problem/problem.exception.js';
import type { ProjectCtx } from '../common/project-context.js';
import { insertAudited, updateAudited } from '../db/audit.js';
import type { Db } from '../db/client.js';
import { DRIZZLE } from '../db/db.module.js';
import { prjBizArea, stdCode, stdCodeCls } from '../db/schema.js';
import { auditJson, writeStdAudit } from './std-audit.js';
import { isoTs, likePattern, limitOffset, orderBy, rowsOf, whereAll } from './std-sql.js';
import { StdWriter } from './std-write.js';

interface ClsRow {
  code_cls_id: number;
  biz_area_id: number;
  biz_cd: string;
  biz_nm: string;
  biz_use_yn: boolean;
  code_cls: string;
  code_cls_nm: string;
  description: string | null;
  code_cnt: number;
  active_code_cnt: number;
  column_cnt: number;
  updated_by: string;
  updated_at: string;
}
const CLS_COLUMNS = sql`c.code_cls_id, c.biz_area_id, b.biz_cd, b.biz_nm, b.use_yn biz_use_yn, c.code_cls, c.code_cls_nm,
  c.description,
  (select count(*) from std_code x where x.code_cls_id = c.code_cls_id)::int code_cnt,
  (select count(*) from std_code x where x.code_cls_id = c.code_cls_id and x.is_active)::int active_code_cnt,
  (select count(*) from prj_column k where k.project_id = c.project_id and k.code_cls_id = c.code_cls_id)::int column_cnt,
  c.updated_by, ${isoTs(sql`c.updated_at`)} updated_at`;
const CLS_FROM = sql`std_code_cls c join prj_biz_area b on b.biz_area_id = c.biz_area_id`;

function mapCls(r: ClsRow): CodeClsItem {
  return {
    codeClsId: r.code_cls_id,
    bizAreaId: r.biz_area_id,
    bizCd: r.biz_cd,
    bizNm: r.biz_nm,
    bizUseYn: r.biz_use_yn,
    codeCls: r.code_cls,
    codeClsNm: r.code_cls_nm,
    description: r.description,
    codeCnt: r.code_cnt,
    activeCodeCnt: r.active_code_cnt,
    columnCnt: r.column_cnt,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  };
}

interface CodeRow {
  code_id: number;
  code_cls_id: number;
  code: string;
  code_nm: string;
  sort_order: number | null;
  is_active: boolean;
  updated_by: string;
  updated_at: string;
}
function mapCode(r: CodeRow): CodeItem {
  return {
    codeId: r.code_id,
    codeClsId: r.code_cls_id,
    code: r.code,
    codeNm: r.code_nm,
    sortOrder: r.sort_order,
    isActive: r.is_active,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  };
}

const SORTS = {
  bizCd: sql`b.sort_no, b.biz_cd`,
  codeCls: sql`c.code_cls`,
  codeClsNm: sql`c.code_cls_nm`,
  updatedAt: sql`c.updated_at`,
} as const;

/**
 * 코드구분·코드(T6.5, 설계서 §3.5.8~9·§4.2). 코드구분은 업무구분에 속하고(복합 FK), 판정 키는 (업무구분, 코드구분) 쌍이다
 * (CR-04 §4: 같은 code_cls 값이 여러 업무구분에 있다). 사용 중지 업무구분에는 새 코드구분을 만들거나 옮길 수 없다(422).
 * 코드구분 삭제는 코드 CASCADE + 참조 컬럼 code_cls_id SET NULL(§4.8 `W_CODE_CLS_MISSING`).
 */
@Injectable()
export class CodeService {
  private readonly logger = new Logger('Codes');

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly writer: StdWriter,
  ) {}

  async listClasses(ctx: ProjectCtx, q: CodeClsListQuery): Promise<Page<CodeClsItem>> {
    const where = whereAll([
      sql`c.project_id = ${ctx.projectId}`,
      q.bizAreaId ? sql`c.biz_area_id = ${q.bizAreaId}` : undefined,
      q.q
        ? sql`(c.code_cls ilike ${likePattern(q.q)} or c.code_cls_nm ilike ${likePattern(q.q)}
               or exists (select 1 from std_code x where x.code_cls_id = c.code_cls_id
                           and (x.code ilike ${likePattern(q.q)} or x.code_nm ilike ${likePattern(q.q)})))`
        : undefined,
    ]);
    const [rows, [cnt]] = await Promise.all([
      rowsOf<ClsRow>(
        this.db,
        sql`select ${CLS_COLUMNS} from ${CLS_FROM} where ${where}
            order by ${orderBy(q.sort, SORTS, sql`b.sort_no, b.biz_cd, c.code_cls`, sql`c.code_cls_id`)} ${limitOffset(q)}`,
      ),
      rowsOf<{ n: number }>(this.db, sql`select count(*)::int n from ${CLS_FROM} where ${where}`),
    ]);
    return { items: rows.map(mapCls), page: q.page, size: q.size, total: cnt?.n ?? 0 };
  }

  private async clsItem(projectId: number, id: number): Promise<CodeClsItem> {
    const [r] = await rowsOf<ClsRow>(
      this.db,
      sql`select ${CLS_COLUMNS} from ${CLS_FROM} where c.project_id = ${projectId} and c.code_cls_id = ${id}`,
    );
    if (!r) throw new NotFoundProblem('코드구분을 찾을 수 없습니다');
    return mapCls(r);
  }

  async detail(
    ctx: ProjectCtx,
    id: number,
    opts: { q?: string | undefined; includeInactive?: boolean | undefined } = {},
  ): Promise<CodeClsDetail> {
    const codeCls = await this.clsItem(ctx.projectId, id);
    const [codes, samples] = await Promise.all([
      this.codes(ctx, id, opts),
      rowsOf<{ s: string }>(
        this.db,
        sql`select t.table_nm || '.' || k.physical_nm s from prj_column k join prj_table t on t.table_id = k.table_id
             where k.project_id = ${ctx.projectId} and k.code_cls_id = ${id} order by t.table_nm, k.col_seq limit 3`,
      ),
    ]);
    return { codeCls, codes, columnSamples: samples.map((r) => r.s) };
  }

  async codes(
    ctx: ProjectCtx,
    clsId: number,
    opts: { q?: string | undefined; includeInactive?: boolean | undefined } = {},
  ): Promise<CodeItem[]> {
    const rows = await rowsOf<CodeRow>(
      this.db,
      sql`select x.code_id, x.code_cls_id, x.code, x.code_nm, x.sort_order, x.is_active, x.updated_by,
                 ${isoTs(sql`x.updated_at`)} updated_at
            from std_code x
           where ${whereAll([
             sql`x.project_id = ${ctx.projectId}`,
             sql`x.code_cls_id = ${clsId}`,
             opts.includeInactive === false ? sql`x.is_active` : undefined,
             opts.q
               ? sql`(x.code ilike ${likePattern(opts.q)} or x.code_nm ilike ${likePattern(opts.q)})`
               : undefined,
           ])}
           order by x.sort_order nulls last, x.code, x.code_id`,
    );
    return rows.map(mapCode);
  }

  /** 업무구분이 이 프로젝트 소속·사용 중인지(새 코드구분·이동 대상). 다른 프로젝트 ID는 404가 아니라 422(본문 참조). */
  private async assertBizArea(
    projectId: number,
    bizAreaId: number,
    requireActive: boolean,
  ): Promise<{ bizCd: string }> {
    const [b] = await this.db
      .select({ bizCd: prjBizArea.bizCd, useYn: prjBizArea.useYn })
      .from(prjBizArea)
      .where(and(eq(prjBizArea.projectId, projectId), eq(prjBizArea.bizAreaId, bizAreaId)));
    if (!b) {
      throw new ValidationProblem([
        {
          code: 'E_BIZ_AREA_NOT_FOUND',
          target: 'field',
          field: 'bizAreaId',
          message: API_ERROR_CODES.E_BIZ_AREA_NOT_FOUND,
        },
      ]);
    }
    if (requireActive && !b.useYn) {
      throw new ValidationProblem([
        {
          code: 'E_BIZ_AREA_INACTIVE',
          target: 'field',
          field: 'bizAreaId',
          message: `${API_ERROR_CODES.E_BIZ_AREA_INACTIVE}(${b.bizCd})`,
        },
      ]);
    }
    return { bizCd: b.bizCd };
  }

  private async clsOwner(
    projectId: number,
    bizAreaId: number,
    codeCls: string,
  ): Promise<number | undefined> {
    const [r] = await this.db
      .select({ id: stdCodeCls.codeClsId })
      .from(stdCodeCls)
      .where(
        and(
          eq(stdCodeCls.projectId, projectId),
          eq(stdCodeCls.bizAreaId, bizAreaId),
          eq(stdCodeCls.codeCls, codeCls),
        ),
      );
    return r?.id;
  }

  private clsDup(bizCd: string, codeCls: string, id?: number): ConflictProblem {
    return new ConflictProblem(
      'E_CODE_CLS_DUP',
      `${API_ERROR_CODES.E_CODE_CLS_DUP}: ${bizCd}/${codeCls}`,
      { bizCd, codeCls, ...(id !== undefined ? { codeClsId: id } : {}) },
    );
  }

  async createClass(ctx: ProjectCtx, input: CodeClsInput, a: Audit): Promise<CodeClsItem> {
    this.writer.assertWritable(ctx);
    const { bizCd } = await this.assertBizArea(ctx.projectId, input.bizAreaId, true);
    const owner = await this.clsOwner(ctx.projectId, input.bizAreaId, input.codeCls);
    if (owner !== undefined) throw this.clsDup(bizCd, input.codeCls, owner);
    const id = await this.writer.write(ctx, async (tx) => {
      const [r] = await insertAudited(tx, stdCodeCls, { projectId: ctx.projectId, ...input }, a)
        .onConflictDoNothing()
        .returning();
      if (!r) throw this.clsDup(bizCd, input.codeCls);
      await writeStdAudit(
        tx,
        {
          projectId: ctx.projectId,
          entityType: 'CODE_CLS',
          entityId: r.codeClsId,
          action: 'INSERT',
          after: { ...(auditJson(r) as object), bizCd },
        },
        a,
      );
      return r.codeClsId;
    });
    this.logger.log(`코드구분 등록: ${ctx.projectKey} ${bizCd}/${input.codeCls} by ${a.actor}`);
    return this.clsItem(ctx.projectId, id);
  }

  async updateClass(
    ctx: ProjectCtx,
    id: number,
    input: CodeClsInput,
    a: Audit,
  ): Promise<CodeClsItem> {
    this.writer.assertWritable(ctx);
    const [cur] = await this.db
      .select()
      .from(stdCodeCls)
      .where(and(eq(stdCodeCls.projectId, ctx.projectId), eq(stdCodeCls.codeClsId, id)));
    if (!cur) throw new NotFoundProblem('코드구분을 찾을 수 없습니다');
    const moved = input.bizAreaId !== cur.bizAreaId;
    const { bizCd } = await this.assertBizArea(ctx.projectId, input.bizAreaId, moved);
    if (moved || input.codeCls !== cur.codeCls) {
      const owner = await this.clsOwner(ctx.projectId, input.bizAreaId, input.codeCls);
      if (owner !== undefined && owner !== id) throw this.clsDup(bizCd, input.codeCls, owner);
    }
    await this.writer.write(ctx, async (tx) => {
      const [after] = await updateAudited(tx, stdCodeCls, input, a)
        .where(eq(stdCodeCls.codeClsId, id))
        .returning();
      await writeStdAudit(
        tx,
        {
          projectId: ctx.projectId,
          entityType: 'CODE_CLS',
          entityId: id,
          action: 'UPDATE',
          before: auditJson(cur),
          after: auditJson(after),
        },
        a,
      );
    });
    return this.clsItem(ctx.projectId, id);
  }

  async removeClass(ctx: ProjectCtx, id: number, a: Audit): Promise<CodeClsDeleteResponse> {
    this.writer.assertWritable(ctx);
    const item = await this.clsItem(ctx.projectId, id);
    const [cur] = await this.db.select().from(stdCodeCls).where(eq(stdCodeCls.codeClsId, id));
    await this.writer.write(ctx, async (tx) => {
      await tx.delete(stdCodeCls).where(eq(stdCodeCls.codeClsId, id));
      await writeStdAudit(
        tx,
        {
          projectId: ctx.projectId,
          entityType: 'CODE_CLS',
          entityId: id,
          action: 'DELETE',
          before: auditJson(cur),
          after: { deletedCodes: item.codeCnt, affectedColumns: item.columnCnt },
        },
        a,
      );
    });
    this.logger.log(
      `코드구분 삭제: ${ctx.projectKey} ${item.bizCd}/${item.codeCls}(코드 ${item.codeCnt}) by ${a.actor}`,
    );
    return { deletedCodes: item.codeCnt, affectedColumns: item.columnCnt };
  }

  // ── 코드 ──────────────────────────────────────────────────────────────
  private codeDup(code: string, id?: number): ConflictProblem {
    // 확장 필드 이름 `code`는 ProblemDetail.code와 겹치므로 codeValue로 싣는다
    return new ConflictProblem('E_CODE_DUP', `${API_ERROR_CODES.E_CODE_DUP}: ${code}`, {
      codeValue: code,
      ...(id !== undefined ? { codeId: id } : {}),
    });
  }

  private async codeOwner(clsId: number, code: string): Promise<number | undefined> {
    const [r] = await this.db
      .select({ id: stdCode.codeId })
      .from(stdCode)
      .where(and(eq(stdCode.codeClsId, clsId), eq(stdCode.code, code)));
    return r?.id;
  }

  async createCode(ctx: ProjectCtx, clsId: number, input: CodeInput, a: Audit): Promise<CodeItem> {
    this.writer.assertWritable(ctx);
    await this.clsItem(ctx.projectId, clsId);
    const owner = await this.codeOwner(clsId, input.code);
    if (owner !== undefined) throw this.codeDup(input.code, owner);
    const id = await this.writer.write(ctx, async (tx) => {
      const [r] = await insertAudited(
        tx,
        stdCode,
        { projectId: ctx.projectId, codeClsId: clsId, ...input },
        a,
      )
        .onConflictDoNothing()
        .returning();
      if (!r) throw this.codeDup(input.code);
      await writeStdAudit(
        tx,
        {
          projectId: ctx.projectId,
          entityType: 'CODE',
          entityId: r.codeId,
          action: 'INSERT',
          after: auditJson(r),
        },
        a,
      );
      return r.codeId;
    });
    return (await this.codes(ctx, clsId)).find((c) => c.codeId === id)!;
  }

  private async codeRow(ctx: ProjectCtx, clsId: number, codeId: number) {
    const [cur] = await this.db
      .select()
      .from(stdCode)
      .where(
        and(
          eq(stdCode.projectId, ctx.projectId),
          eq(stdCode.codeClsId, clsId),
          eq(stdCode.codeId, codeId),
        ),
      );
    if (!cur) throw new NotFoundProblem('코드를 찾을 수 없습니다');
    return cur;
  }

  async updateCode(
    ctx: ProjectCtx,
    clsId: number,
    codeId: number,
    input: CodeInput,
    a: Audit,
  ): Promise<CodeItem> {
    this.writer.assertWritable(ctx);
    const cur = await this.codeRow(ctx, clsId, codeId);
    if (input.code !== cur.code) {
      const owner = await this.codeOwner(clsId, input.code);
      if (owner !== undefined) throw this.codeDup(input.code, owner);
    }
    await this.writer.write(ctx, async (tx) => {
      const [after] = await updateAudited(tx, stdCode, input, a)
        .where(eq(stdCode.codeId, codeId))
        .returning();
      await writeStdAudit(
        tx,
        {
          projectId: ctx.projectId,
          entityType: 'CODE',
          entityId: codeId,
          action: 'UPDATE',
          before: auditJson(cur),
          after: auditJson(after),
        },
        a,
      );
    });
    return (await this.codes(ctx, clsId)).find((c) => c.codeId === codeId)!;
  }

  async removeCode(ctx: ProjectCtx, clsId: number, codeId: number, a: Audit): Promise<void> {
    this.writer.assertWritable(ctx);
    const cur = await this.codeRow(ctx, clsId, codeId);
    await this.writer.write(ctx, async (tx) => {
      await tx.delete(stdCode).where(eq(stdCode.codeId, codeId));
      await writeStdAudit(
        tx,
        {
          projectId: ctx.projectId,
          entityType: 'CODE',
          entityId: codeId,
          action: 'DELETE',
          before: auditJson(cur),
        },
        a,
      );
    });
  }
}
