import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  API_ERROR_CODES,
  checkStdTypeParts,
  stdTypeProblemIssue,
  typeText,
  type DefaultColInput,
  type DefaultColItem,
  type DefaultColSetInput,
  type DefaultColSetItem,
  type StdType,
  type ValidationIssue,
} from '@termflow/shared';
import type { Audit } from '../common/audit/audit.js';
import { ConflictProblem, NotFoundProblem } from '../common/problem/problem.exception.js';
import type { ProjectCtx } from '../common/project-context.js';
import { insertAudited, updateAudited } from '../db/audit.js';
import type { Db } from '../db/client.js';
import { DRIZZLE } from '../db/db.module.js';
import { stdDefaultCol, stdDefaultColSet, tfProject } from '../db/schema.js';
import { auditJson, writeStdAudit } from './std-audit.js';
import { isoTs, rowsOf, throwIfErrors } from './std-sql.js';
import { StdWriter, type Tx } from './std-write.js';

interface SetRow {
  set_id: number;
  set_nm: string;
  description: string | null;
  is_default: boolean;
  column_ref_cnt: number;
  updated_by: string;
  updated_at: string;
}
interface ColRow {
  default_col_id: number;
  set_id: number;
  col_seq: number;
  logical_nm: string;
  physical_nm: string;
  is_pk: boolean;
  data_type: StdType;
  data_length: number | null;
  data_scale: number | null;
  is_nullable: boolean;
  default_val: string | null;
  col_comment: string | null;
}

function mapCol(r: ColRow): DefaultColItem {
  return {
    defaultColId: r.default_col_id,
    colSeq: r.col_seq,
    logicalNm: r.logical_nm,
    physicalNm: r.physical_nm,
    isPk: r.is_pk,
    dataType: r.data_type,
    dataLength: r.data_length,
    dataScale: r.data_scale,
    typeText: typeText(r.data_type, r.data_length, r.data_scale) ?? r.data_type,
    isNullable: r.is_nullable,
    defaultVal: r.default_val,
    colComment: r.col_comment,
  };
}

/**
 * 기본컬럼 세트·구성(T6.6, 설계서 §3.5.10). 프로젝트당 기본 세트 1개(부분 유니크 `ux_std_default_col_set_default`):
 *  - 첫 세트는 자동으로 기본 + `tf_project.default_col_set_id` 지정(CR-04 §4: 두 값을 함께 맞춘다)
 *  - `PUT /{id}/default`: 기존 기본 해제 → 지정(한 트랜잭션), 프로젝트 기본 세트도 같이 바꾼다
 *  - 기본 세트 삭제는 다른 세트가 있으면 409(먼저 다른 세트를 기본으로), 유일한 세트는 삭제 가능(기본 세트 없음)
 *  - 구성 `PUT /{id}/columns`: 전체 교체이되 defaultColId로 기존 행을 유지해 테이블 컬럼의 default_col_id 연결을 보존
 */
@Injectable()
export class DefaultColService {
  private readonly logger = new Logger('DefaultColumns');

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly writer: StdWriter,
  ) {}

  async list(ctx: ProjectCtx): Promise<DefaultColSetItem[]> {
    const sets = await rowsOf<SetRow>(
      this.db,
      sql`select s.set_id, s.set_nm, s.description, s.is_default,
                 (select count(*) from prj_column k join std_default_col c on c.default_col_id = k.default_col_id
                   where c.set_id = s.set_id)::int column_ref_cnt,
                 s.updated_by, ${isoTs(sql`s.updated_at`)} updated_at
            from std_default_col_set s where s.project_id = ${ctx.projectId}
           order by s.is_default desc, s.set_nm, s.set_id`,
    );
    const cols = await rowsOf<ColRow>(
      this.db,
      sql`select default_col_id, set_id, col_seq, logical_nm, physical_nm, is_pk, data_type, data_length, data_scale,
                 is_nullable, default_val, col_comment
            from std_default_col where project_id = ${ctx.projectId} order by set_id, col_seq`,
    );
    const bySet = new Map<number, DefaultColItem[]>();
    for (const c of cols) {
      const list = bySet.get(c.set_id) ?? [];
      list.push(mapCol(c));
      bySet.set(c.set_id, list);
    }
    return sets.map((s) => ({
      setId: s.set_id,
      setNm: s.set_nm,
      description: s.description,
      isDefault: s.is_default,
      colCnt: bySet.get(s.set_id)?.length ?? 0,
      columns: bySet.get(s.set_id) ?? [],
      columnRefCnt: s.column_ref_cnt,
      updatedBy: s.updated_by,
      updatedAt: s.updated_at,
    }));
  }

  async get(ctx: ProjectCtx, setId: number): Promise<DefaultColSetItem> {
    const s = (await this.list(ctx)).find((x) => x.setId === setId);
    if (!s) throw new NotFoundProblem('기본컬럼 세트를 찾을 수 없습니다');
    return s;
  }

  private async setRow(ctx: ProjectCtx, setId: number) {
    const [cur] = await this.db
      .select()
      .from(stdDefaultColSet)
      .where(and(eq(stdDefaultColSet.projectId, ctx.projectId), eq(stdDefaultColSet.setId, setId)));
    if (!cur) throw new NotFoundProblem('기본컬럼 세트를 찾을 수 없습니다');
    return cur;
  }

  private dup(setNm: string): ConflictProblem {
    return new ConflictProblem(
      'E_DEFAULT_COL_SET_DUP',
      `${API_ERROR_CODES.E_DEFAULT_COL_SET_DUP}: ${setNm}`,
      { setNm },
    );
  }

  private async nameTaken(projectId: number, setNm: string, exceptId?: number): Promise<boolean> {
    const n = await this.db.$count(
      stdDefaultColSet,
      and(
        eq(stdDefaultColSet.projectId, projectId),
        eq(stdDefaultColSet.setNm, setNm),
        exceptId !== undefined ? ne(stdDefaultColSet.setId, exceptId) : undefined,
      ),
    );
    return n > 0;
  }

  async create(ctx: ProjectCtx, input: DefaultColSetInput, a: Audit): Promise<DefaultColSetItem> {
    this.writer.assertWritable(ctx);
    if (await this.nameTaken(ctx.projectId, input.setNm)) throw this.dup(input.setNm);
    const id = await this.writer.write(ctx, async (tx) => {
      const hasDefault =
        (await tx.$count(
          stdDefaultColSet,
          and(eq(stdDefaultColSet.projectId, ctx.projectId), eq(stdDefaultColSet.isDefault, true)),
        )) > 0;
      const [r] = await insertAudited(
        tx,
        stdDefaultColSet,
        { projectId: ctx.projectId, ...input, isDefault: !hasDefault },
        a,
      )
        .onConflictDoNothing()
        .returning();
      if (!r) throw this.dup(input.setNm);
      if (!hasDefault) await this.pointProject(tx, ctx.projectId, r.setId, a);
      await writeStdAudit(
        tx,
        {
          projectId: ctx.projectId,
          entityType: 'DEFAULT_COL_SET',
          entityId: r.setId,
          action: 'INSERT',
          after: auditJson(r),
        },
        a,
      );
      return r.setId;
    });
    this.logger.log(`기본컬럼 세트 추가: ${ctx.projectKey} ${input.setNm} by ${a.actor}`);
    return this.get(ctx, id);
  }

  async update(
    ctx: ProjectCtx,
    setId: number,
    input: DefaultColSetInput,
    a: Audit,
  ): Promise<DefaultColSetItem> {
    this.writer.assertWritable(ctx);
    const cur = await this.setRow(ctx, setId);
    if (input.setNm !== cur.setNm && (await this.nameTaken(ctx.projectId, input.setNm, setId)))
      throw this.dup(input.setNm);
    await this.writer.write(ctx, async (tx) => {
      const [after] = await updateAudited(tx, stdDefaultColSet, input, a)
        .where(eq(stdDefaultColSet.setId, setId))
        .returning();
      await writeStdAudit(
        tx,
        {
          projectId: ctx.projectId,
          entityType: 'DEFAULT_COL_SET',
          entityId: setId,
          action: 'UPDATE',
          before: auditJson(cur),
          after: auditJson(after),
        },
        a,
      );
    });
    return this.get(ctx, setId);
  }

  /** 기본 세트 지정(부분 유니크 때문에 해제 → 지정 순서, 한 트랜잭션) + 프로젝트 기본 세트 동기화. */
  async setDefault(ctx: ProjectCtx, setId: number, a: Audit): Promise<DefaultColSetItem> {
    this.writer.assertWritable(ctx);
    const cur = await this.setRow(ctx, setId);
    await this.writer.write(ctx, async (tx) => {
      const prev = await updateAudited(tx, stdDefaultColSet, { isDefault: false }, a)
        .where(
          and(
            eq(stdDefaultColSet.projectId, ctx.projectId),
            eq(stdDefaultColSet.isDefault, true),
            ne(stdDefaultColSet.setId, setId),
          ),
        )
        .returning();
      const [after] = await updateAudited(tx, stdDefaultColSet, { isDefault: true }, a)
        .where(eq(stdDefaultColSet.setId, setId))
        .returning();
      await this.pointProject(tx, ctx.projectId, setId, a);
      await writeStdAudit(
        tx,
        [
          ...prev.map((p) => ({
            projectId: ctx.projectId,
            entityType: 'DEFAULT_COL_SET' as const,
            entityId: p.setId,
            action: 'UPDATE' as const,
            before: { isDefault: true },
            after: { isDefault: false },
          })),
          {
            projectId: ctx.projectId,
            entityType: 'DEFAULT_COL_SET',
            entityId: setId,
            action: 'UPDATE',
            before: auditJson(cur),
            after: auditJson(after),
          },
        ],
        a,
      );
    });
    return this.get(ctx, setId);
  }

  private async pointProject(tx: Tx, projectId: number, setId: number, a: Audit): Promise<void> {
    await updateAudited(tx, tfProject, { defaultColSetId: setId }, a).where(
      eq(tfProject.projectId, projectId),
    );
  }

  async remove(ctx: ProjectCtx, setId: number, a: Audit): Promise<void> {
    this.writer.assertWritable(ctx);
    const cur = await this.setRow(ctx, setId);
    const others = await this.db.$count(
      stdDefaultColSet,
      and(eq(stdDefaultColSet.projectId, ctx.projectId), ne(stdDefaultColSet.setId, setId)),
    );
    if (cur.isDefault && others > 0) {
      throw new ConflictProblem(
        'E_DEFAULT_COL_SET_DEFAULT',
        API_ERROR_CODES.E_DEFAULT_COL_SET_DEFAULT,
      );
    }
    const cols = await this.db.select().from(stdDefaultCol).where(eq(stdDefaultCol.setId, setId));
    await this.writer.write(ctx, async (tx) => {
      // tf_project.default_col_set_id는 FK SET NULL(열)로 비워진다
      await tx.delete(stdDefaultColSet).where(eq(stdDefaultColSet.setId, setId));
      await writeStdAudit(
        tx,
        [
          {
            projectId: ctx.projectId,
            entityType: 'DEFAULT_COL_SET',
            entityId: setId,
            action: 'DELETE',
            before: { ...(auditJson(cur) as object), columns: cols.map((c) => auditJson(c)) },
          },
        ],
        a,
      );
    });
    this.logger.log(`기본컬럼 세트 삭제: ${ctx.projectKey} ${cur.setNm} by ${a.actor}`);
  }

  /** 구성 검사: 세트 안 물리명 중복 409(E_DEFAULT_COL_DUP), 타입 길이 규칙 422, PK는 NOT NULL로 보정. */
  private validateColumns(columns: DefaultColInput[], existingIds: Set<number>): DefaultColInput[] {
    const seen = new Map<string, number>();
    for (const [i, c] of columns.entries()) {
      const prev = seen.get(c.physicalNm);
      if (prev !== undefined) {
        throw new ConflictProblem(
          'E_DEFAULT_COL_DUP',
          `${API_ERROR_CODES.E_DEFAULT_COL_DUP}: ${c.physicalNm}(${prev + 1}행·${i + 1}행)`,
          { physicalNm: c.physicalNm, rowIndex: i },
        );
      }
      seen.set(c.physicalNm, i);
    }
    const errors: ValidationIssue[] = [];
    columns.forEach((c, i) => {
      const p = checkStdTypeParts(c.dataType, c.dataLength, c.dataScale);
      if (p)
        errors.push({
          ...stdTypeProblemIssue(p, c.dataType),
          target: 'column',
          rowIndex: i,
          field: 'dataLength',
        });
      if (c.defaultColId !== null && !existingIds.has(c.defaultColId)) {
        errors.push({
          code: 'E_NOT_FOUND',
          target: 'column',
          rowIndex: i,
          field: 'defaultColId',
          message: `이 세트의 기본컬럼이 아닙니다: ${c.defaultColId}`,
        });
      }
    });
    throwIfErrors(errors);
    return columns.map((c) => (c.isPk ? { ...c, isNullable: false } : c));
  }

  async putColumns(
    ctx: ProjectCtx,
    setId: number,
    columns: DefaultColInput[],
    a: Audit,
  ): Promise<DefaultColSetItem> {
    this.writer.assertWritable(ctx);
    await this.setRow(ctx, setId);
    const cur = await this.db.select().from(stdDefaultCol).where(eq(stdDefaultCol.setId, setId));
    const byId = new Map(cur.map((c) => [c.defaultColId, c]));
    const cols = this.validateColumns(columns, new Set(byId.keys()));
    const keep = new Set(cols.flatMap((c) => (c.defaultColId !== null ? [c.defaultColId] : [])));
    const removed = cur.filter((c) => !keep.has(c.defaultColId));
    await this.writer.write(ctx, async (tx) => {
      if (removed.length > 0) {
        await tx.delete(stdDefaultCol).where(
          inArray(
            stdDefaultCol.defaultColId,
            removed.map((r) => r.defaultColId),
          ),
        );
      }
      // 유니크(set_id, col_seq)·(set_id, physical_nm)가 즉시 검사라 남는 행을 임시 값으로 비켜 둔다
      if (keep.size > 0) {
        await tx.execute(
          sql`update std_default_col set col_seq = -col_seq - 1000, physical_nm = 'TF__TMP_' || default_col_id
               where set_id = ${setId} and default_col_id = any(${sql.param([...keep])}::int[])`,
        );
      }
      const entries: Parameters<typeof writeStdAudit>[1] = removed.map((r) => ({
        projectId: ctx.projectId,
        entityType: 'DEFAULT_COL' as const,
        entityId: r.defaultColId,
        action: 'DELETE' as const,
        before: auditJson(r),
      }));
      for (const [i, c] of cols.entries()) {
        const values = {
          colSeq: i + 1,
          logicalNm: c.logicalNm,
          physicalNm: c.physicalNm,
          isPk: c.isPk,
          dataType: c.dataType,
          dataLength: c.dataLength,
          dataScale: c.dataScale,
          isNullable: c.isNullable,
          defaultVal: c.defaultVal,
          colComment: c.colComment,
        };
        if (c.defaultColId !== null) {
          const before = byId.get(c.defaultColId)!;
          const [after] = await updateAudited(tx, stdDefaultCol, values, a)
            .where(eq(stdDefaultCol.defaultColId, c.defaultColId))
            .returning();
          const b = auditJson(before) as Record<string, unknown>;
          const n = auditJson(after) as Record<string, unknown>;
          if (JSON.stringify(b) !== JSON.stringify(n))
            entries.push({
              projectId: ctx.projectId,
              entityType: 'DEFAULT_COL',
              entityId: c.defaultColId,
              action: 'UPDATE',
              before: b,
              after: n,
            });
        } else {
          const [r] = await insertAudited(
            tx,
            stdDefaultCol,
            { projectId: ctx.projectId, setId, ...values },
            a,
          ).returning();
          entries.push({
            projectId: ctx.projectId,
            entityType: 'DEFAULT_COL',
            entityId: r!.defaultColId,
            action: 'INSERT',
            after: auditJson(r),
          });
        }
      }
      await writeStdAudit(tx, entries, a);
    });
    return this.get(ctx, setId);
  }
}
