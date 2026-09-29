import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import {
  API_ERROR_CODES,
  type BizAreaDeletePreview,
  type BizAreaDeleteResponse,
  type BizAreaInput,
  type BizAreaItem,
} from '@termflow/shared';
import { TermCacheRegistry } from '../autocomplete/term-cache-registry.js';
import type { Audit } from '../common/audit/audit.js';
import { ConflictProblem, NotFoundProblem } from '../common/problem/problem.exception.js';
import type { ProjectCtx } from '../common/project-context.js';
import { insertAudited, updateAudited } from '../db/audit.js';
import type { Db } from '../db/client.js';
import { DRIZZLE } from '../db/db.module.js';
import { prjBizArea } from '../db/schema.js';
import { auditJson, writeStdAudit } from '../standard/std-audit.js';
import { rowsOf } from './sql-util.js';

/**
 * 업무구분(T5.7, 설계서 §4.2·§3.5.4). 테이블이 1개라도 있으면 코드·접두어 변경·사용 중지·삭제는 409 `E_BIZ_AREA_IN_USE`
 * (목업 가정 M2). 삭제는 테이블 0건일 때만, 소속 코드구분·코드는 FK CASCADE, 다른 업무구분 테이블 컬럼의
 * code_cls_id는 SET NULL(열). 쓰기는 감사 `BIZ_AREA` + 커밋 후 캐시 무효화(TermCacheRegistry, 단계 9 구현).
 */
@Injectable()
export class BizAreaService {
  private readonly logger = new Logger('BizAreas');

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: TermCacheRegistry,
  ) {}

  async list(ctx: ProjectCtx): Promise<BizAreaItem[]> {
    const rows = await rowsOf<{
      id: number;
      biz_cd: string;
      biz_nm: string;
      table_prefix: string | null;
      sort_no: number;
      use_yn: boolean;
      description: string | null;
      table_cnt: number;
      code_cls_cnt: number;
      origin_id: number | null;
      origin_key: string | null;
      origin_nm: string | null;
    }>(
      this.db,
      sql`select b.biz_area_id id, b.biz_cd, b.biz_nm, b.table_prefix, b.sort_no, b.use_yn, b.description,
                 (select count(*) from prj_table t where t.biz_area_id = b.biz_area_id)::int table_cnt,
                 (select count(*) from std_code_cls c where c.biz_area_id = b.biz_area_id)::int code_cls_cnt,
                 b.origin_id, o.project_key origin_key, o.project_nm origin_nm
            from prj_biz_area b left join tf_project o on o.project_id = b.origin_project_id
           where b.project_id = ${ctx.projectId}
           order by b.sort_no, b.biz_cd`,
    );
    return rows.map((r) => ({
      bizAreaId: r.id,
      bizCd: r.biz_cd,
      bizNm: r.biz_nm,
      tablePrefix: r.table_prefix,
      sortNo: r.sort_no,
      useYn: r.use_yn,
      description: r.description,
      tableCnt: r.table_cnt,
      codeClsCnt: r.code_cls_cnt,
      locked: r.table_cnt > 0,
      origin:
        r.origin_id !== null || r.origin_key !== null
          ? { projectKey: r.origin_key, projectNm: r.origin_nm }
          : null,
    }));
  }

  private async get(ctx: ProjectCtx, id: number): Promise<BizAreaItem> {
    const item = (await this.list(ctx)).find((b) => b.bizAreaId === id);
    if (!item) throw new NotFoundProblem('업무구분을 찾을 수 없습니다');
    return item;
  }

  private async row(ctx: ProjectCtx, id: number) {
    const [r] = await this.db
      .select()
      .from(prjBizArea)
      .where(and(eq(prjBizArea.bizAreaId, id), eq(prjBizArea.projectId, ctx.projectId)));
    if (!r) throw new NotFoundProblem('업무구분을 찾을 수 없습니다');
    return r;
  }

  private async assertCdFree(ctx: ProjectCtx, bizCd: string, exceptId?: number): Promise<void> {
    const n = await this.db.$count(
      prjBizArea,
      and(
        eq(prjBizArea.projectId, ctx.projectId),
        eq(prjBizArea.bizCd, bizCd),
        exceptId === undefined ? undefined : ne(prjBizArea.bizAreaId, exceptId),
      ),
    );
    if (n > 0)
      throw new ConflictProblem('E_BIZ_AREA_DUP', `${API_ERROR_CODES.E_BIZ_AREA_DUP}: ${bizCd}`);
  }

  async create(ctx: ProjectCtx, input: BizAreaInput, a: Audit): Promise<BizAreaItem> {
    await this.assertCdFree(ctx, input.bizCd);
    const id = await this.db.transaction(async (tx) => {
      const [r] = await insertAudited(
        tx,
        prjBizArea,
        {
          projectId: ctx.projectId,
          bizCd: input.bizCd,
          bizNm: input.bizNm,
          tablePrefix: input.tablePrefix === undefined ? `${input.bizCd}_` : input.tablePrefix,
          sortNo: input.sortNo,
          useYn: input.useYn,
          description: input.description,
        },
        a,
      )
        .onConflictDoNothing()
        .returning();
      if (!r)
        throw new ConflictProblem(
          'E_BIZ_AREA_DUP',
          `${API_ERROR_CODES.E_BIZ_AREA_DUP}: ${input.bizCd}`,
        );
      await writeStdAudit(
        tx,
        {
          projectId: ctx.projectId,
          entityType: 'BIZ_AREA',
          entityId: r.bizAreaId,
          action: 'INSERT',
          after: auditJson(r),
        },
        a,
      );
      return r.bizAreaId;
    });
    this.cache.invalidate(ctx.projectId);
    this.logger.log(`업무구분 추가: ${ctx.projectKey} ${input.bizCd} by ${a.actor}`);
    return this.get(ctx, id);
  }

  /**
   * 수정(PUT = 전체 교체, tablePrefix 생략은 유지). 잠금(테이블 ≥ 1): 코드·접두어 변경, 사용 → 중지 거부.
   */
  async update(ctx: ProjectCtx, id: number, input: BizAreaInput, a: Audit): Promise<BizAreaItem> {
    const cur = await this.row(ctx, id);
    const tableCnt = await this.tableCnt(id);
    const prefix = input.tablePrefix === undefined ? cur.tablePrefix : input.tablePrefix;
    if (tableCnt > 0) {
      const blocked: string[] = [];
      if (input.bizCd !== cur.bizCd) blocked.push('코드');
      if (prefix !== cur.tablePrefix) blocked.push('테이블 접두어');
      if (cur.useYn && !input.useYn) blocked.push('사용 중지');
      if (blocked.length > 0) {
        throw new ConflictProblem(
          'E_BIZ_AREA_IN_USE',
          `테이블 ${tableCnt}개가 있어 변경할 수 없습니다(${blocked.join('·')})`,
          { tableCnt, fields: blocked },
        );
      }
    }
    if (input.bizCd !== cur.bizCd) await this.assertCdFree(ctx, input.bizCd, id);
    await this.db.transaction(async (tx) => {
      const [after] = await updateAudited(
        tx,
        prjBizArea,
        {
          bizCd: input.bizCd,
          bizNm: input.bizNm,
          tablePrefix: prefix,
          sortNo: input.sortNo,
          useYn: input.useYn,
          description: input.description,
        },
        a,
      )
        .where(eq(prjBizArea.bizAreaId, id))
        .returning();
      await writeStdAudit(
        tx,
        {
          projectId: ctx.projectId,
          entityType: 'BIZ_AREA',
          entityId: id,
          action: 'UPDATE',
          before: auditJson(cur),
          after: auditJson(after),
        },
        a,
      );
    });
    this.cache.invalidate(ctx.projectId);
    return this.get(ctx, id);
  }

  async deletePreview(ctx: ProjectCtx, id: number): Promise<BizAreaDeletePreview> {
    await this.row(ctx, id);
    const [r] = await rowsOf<BizAreaDeletePreview>(
      this.db,
      sql`select (select count(*) from prj_table t where t.biz_area_id = ${id})::int "tableCnt",
                 (select count(*) from std_code_cls c where c.biz_area_id = ${id})::int "codeClsCnt",
                 (select count(*) from std_code x join std_code_cls c on c.code_cls_id = x.code_cls_id
                   where c.biz_area_id = ${id})::int "codeCnt",
                 (select count(*) from prj_column k join std_code_cls c on c.code_cls_id = k.code_cls_id
                   where c.biz_area_id = ${id})::int "referencingColumnCnt"`,
    );
    return r!;
  }

  async remove(ctx: ProjectCtx, id: number, a: Audit): Promise<BizAreaDeleteResponse> {
    const cur = await this.row(ctx, id);
    const p = await this.deletePreview(ctx, id);
    if (p.tableCnt > 0) {
      throw new ConflictProblem(
        'E_BIZ_AREA_IN_USE',
        `테이블 ${p.tableCnt}개가 있어 삭제할 수 없습니다`,
        { tableCnt: p.tableCnt },
      );
    }
    await this.db.transaction(async (tx) => {
      await tx.delete(prjBizArea).where(eq(prjBizArea.bizAreaId, id));
      await writeStdAudit(
        tx,
        {
          projectId: ctx.projectId,
          entityType: 'BIZ_AREA',
          entityId: id,
          action: 'DELETE',
          before: auditJson(cur),
          after: {
            deletedCodeCls: p.codeClsCnt,
            deletedCodes: p.codeCnt,
            affectedColumns: p.referencingColumnCnt,
          },
        },
        a,
      );
    });
    this.cache.invalidate(ctx.projectId);
    this.logger.log(
      `업무구분 삭제: ${ctx.projectKey} ${cur.bizCd} by ${a.actor} (코드구분 ${p.codeClsCnt}·코드 ${p.codeCnt})`,
    );
    return {
      deletedCodeCls: p.codeClsCnt,
      deletedCodes: p.codeCnt,
      affectedColumns: p.referencingColumnCnt,
    };
  }

  private async tableCnt(id: number): Promise<number> {
    const [r] = await rowsOf<{ n: number }>(
      this.db,
      sql`select count(*)::int n from prj_table where biz_area_id = ${id}`,
    );
    return r?.n ?? 0;
  }
}
