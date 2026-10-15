import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type {
  Dialect,
  TableListItem,
  TableListQuery,
  TablePage,
  TableStatus,
} from '@termflow/shared';
import type { ProjectCtx } from '../common/project-context.js';
import type { Db } from '../db/client.js';
import { DRIZZLE } from '../db/db.module.js';
import { validateTable } from '../ddl/validator.js';
import { isoTs, likePattern, rowsOf } from '../project/sql-util.js';
import { limitOffset, orderBy, whereAll } from '../standard/std-sql.js';
import { loadDesignContext, loadSuffixes, loadTableModels } from './table-model.loader.js';

const SORTS = {
  tableNm: sql`t.table_nm collate "C"`,
  logicalNm: sql`t.table_logical_nm collate "C"`,
  bizCd: sql`b.biz_cd collate "C"`,
  status: sql`t.status`,
  colCnt: sql`col_cnt`,
  updatedAt: sql`t.updated_at`,
} as const;

interface Row {
  table_id: number;
  biz_area_id: number;
  biz_cd: string;
  table_nm: string;
  table_logical_nm: string;
  status: TableStatus;
  version: number;
  col_cnt: number;
  updated_by: string;
  updated_at: string;
  review_yn: boolean;
  review_note: string | null;
}

/**
 * 테이블 목록(T7.9, 설계서 §9.3 `GET P/tables`, 목업 09): 업무구분·검색(물리명·논리명)·상태·정렬·페이지.
 * 건수: 좌측 업무구분(`bizAreaCounts`·`allCnt` — 검색·상태 필터 적용, 업무구분 필터 제외) · 상태 세그먼트(`statusCounts` — 업무구분·검색 적용).
 * `warningCnt`·`errorCnt`는 페이지 행만 TableValidator로 재검증(DDL 생성과 같은 규칙, §5.7).
 */
@Injectable()
export class TableListService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(ctx: ProjectCtx, q: TableListQuery): Promise<TablePage> {
    const pid = ctx.projectId;
    const search = q.q
      ? sql`(t.table_nm ilike ${likePattern(q.q)} or t.table_logical_nm ilike ${likePattern(q.q)})`
      : undefined;
    const biz = q.bizAreaId !== undefined ? sql`t.biz_area_id = ${q.bizAreaId}` : undefined;
    const status = q.status ? sql`t.status = ${q.status}` : undefined;
    const where = whereAll([sql`t.project_id = ${pid}`, biz, search, status]);
    const [rows, [cnt], bizCounts, statusCounts, [proj]] = await Promise.all([
      rowsOf<Row>(
        this.db,
        sql`select t.table_id, t.biz_area_id, b.biz_cd, t.table_nm, t.table_logical_nm, t.status, t.version,
                   (select count(*) from prj_column c where c.table_id = t.table_id)::int col_cnt,
                   t.updated_by, ${isoTs(sql`t.updated_at`)} updated_at, t.review_yn, t.review_note
              from prj_table t join prj_biz_area b on b.biz_area_id = t.biz_area_id
             where ${where}
             order by ${orderBy(q.sort, SORTS, sql`t.updated_at desc, t.table_nm collate "C" asc`, sql`t.table_id asc`)}
             ${limitOffset(q)}`,
      ),
      rowsOf<{ n: number }>(this.db, sql`select count(*)::int n from prj_table t where ${where}`),
      rowsOf<{ biz_area_id: number; n: number }>(
        this.db,
        sql`select t.biz_area_id, count(*)::int n from prj_table t
             where ${whereAll([sql`t.project_id = ${pid}`, search, status])} group by 1`,
      ),
      rowsOf<{ status: TableStatus; n: number }>(
        this.db,
        sql`select t.status, count(*)::int n from prj_table t
             where ${whereAll([sql`t.project_id = ${pid}`, biz, search])} group by 1`,
      ),
      rowsOf<{ default_dialect: Dialect }>(
        this.db,
        sql`select default_dialect from tf_project where project_id = ${pid}`,
      ),
    ]);

    const [models, suffixes] = await Promise.all([
      loadTableModels(
        this.db,
        pid,
        rows.map((r) => r.table_id),
      ),
      loadSuffixes(this.db, pid),
    ]);
    // 설계 규칙(T18.12)도 편집기 저장 검증과 같게 센다 — 다른 테이블 판정은 검증기가 테이블명으로 자기 행을 뺀다
    const design = await loadDesignContext(
      this.db,
      pid,
      models.flatMap((m) => m.columns.map((c) => c.physicalNm)),
    );
    const dialect = proj?.default_dialect ?? 'POSTGRESQL';
    const checked = new Map(
      models.map((m) => [m.tableId!, validateTable(m, { dialect, suffixes, design })]),
    );
    const items: TableListItem[] = rows.map((r) => {
      const v = checked.get(r.table_id) ?? { errors: [], warnings: [] };
      return {
        tableId: r.table_id,
        bizAreaId: r.biz_area_id,
        bizCd: r.biz_cd,
        tableNm: r.table_nm,
        logicalNm: r.table_logical_nm,
        status: r.status,
        version: r.version,
        colCnt: r.col_cnt,
        updatedBy: r.updated_by,
        updatedAt: r.updated_at,
        errorCnt: v.errors.length,
        warningCnt: v.warnings.length,
        issues: [...v.errors, ...v.warnings].slice(0, 3).map((i) => ({
          code: i.code,
          message: i.columnNm ? `${i.columnNm}: ${i.message}` : i.message,
        })),
        reviewYn: r.review_yn,
        reviewNote: r.review_note,
      };
    });
    const sc: Record<TableStatus, number> = { DRAFT: 0, FINAL: 0 };
    for (const s of statusCounts) sc[s.status] = s.n;
    return {
      items,
      page: q.page,
      size: q.size,
      total: cnt?.n ?? 0,
      bizAreaCounts: bizCounts.map((b) => ({ bizAreaId: b.biz_area_id, cnt: b.n })),
      allCnt: bizCounts.reduce((n, b) => n + b.n, 0),
      statusCounts: sc,
    };
  }
}
