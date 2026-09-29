import { sql } from 'drizzle-orm';
import type { ColumnInput, TableCreateInput } from '@termflow/shared';
import {
  assembleModels,
  codeSummaries,
  domainRefs,
  toColumnModel,
  type BizAreaRow,
  type CodeClsRow,
  type CodeRow,
  type ColumnRow,
  type DomainRow,
  type ModelRows,
  type TableRow,
} from '../ddl/assemble.js';
import type { TableModel } from '../ddl/model.js';
import { rowsOf, type ExecQ } from '../project/sql-util.js';

/**
 * TableModel 조립용 조회(설계서 §6.1 "1회 조회": 테이블·업무구분·컬럼·도메인·코드구분·코드 6문장, 테이블 수와 무관).
 * 모든 조회는 `project_id`로 한정한다(교차 프로젝트 참조 금지, §9.1).
 */
const ints = (ids: readonly number[]) => sql`${sql.param([...ids])}::int[]`;

export async function loadBizAreas(q: ExecQ, projectId: number): Promise<BizAreaRow[]> {
  return rowsOf<BizAreaRow>(
    q,
    sql`select biz_area_id, biz_cd, biz_nm, table_prefix from prj_biz_area where project_id = ${projectId}`,
  );
}

async function refRows(
  q: ExecQ,
  projectId: number,
  domainIds: readonly number[],
  codeClsIds: readonly number[],
): Promise<Pick<ModelRows, 'domains' | 'codeClasses' | 'codes'>> {
  const [domains, codeClasses, codes] = await Promise.all([
    domainIds.length === 0
      ? Promise.resolve([] as DomainRow[])
      : rowsOf<DomainRow>(
          q,
          sql`select domain_id, logical_nm, col_type, col_length, col_scale, review_yn from std_domain
               where project_id = ${projectId} and domain_id = any(${ints(domainIds)})`,
        ),
    codeClsIds.length === 0
      ? Promise.resolve([] as CodeClsRow[])
      : rowsOf<CodeClsRow>(
          q,
          sql`select code_cls_id, biz_area_id, code_cls, code_cls_nm from std_code_cls
               where project_id = ${projectId} and code_cls_id = any(${ints(codeClsIds)})`,
        ),
    codeClsIds.length === 0
      ? Promise.resolve([] as CodeRow[])
      : rowsOf<CodeRow>(
          q,
          sql`select code_cls_id, code, code_nm, sort_order, is_active from std_code
               where project_id = ${projectId} and code_cls_id = any(${ints(codeClsIds)})`,
        ),
  ]);
  return { domains, codeClasses, codes };
}

/** 저장된 테이블 → 모델. 결과 순서 = `tableIds` 순서(없는 ID는 빠진다 — 호출자가 소속 검사). */
export async function loadTableModels(
  q: ExecQ,
  projectId: number,
  tableIds: readonly number[],
): Promise<TableModel[]> {
  if (tableIds.length === 0) return [];
  const [tables, columns, bizAreas] = await Promise.all([
    rowsOf<TableRow>(
      q,
      sql`select table_id, biz_area_id, table_nm, table_logical_nm, description, status, version
            from prj_table where project_id = ${projectId} and table_id = any(${ints(tableIds)})`,
    ),
    rowsOf<ColumnRow>(
      q,
      sql`select column_id, table_id, col_seq, logical_nm, physical_nm, is_pk, data_type, data_length, data_scale,
                 is_nullable, default_val, col_comment, domain_id, code_cls_id, default_col_id, match_type
            from prj_column where project_id = ${projectId} and table_id = any(${ints(tableIds)})`,
    ),
    loadBizAreas(q, projectId),
  ]);
  const uniq = (v: (number | null)[]) => [...new Set(v.filter((x): x is number => x !== null))];
  const refs = await refRows(
    q,
    projectId,
    uniq(columns.map((c) => c.domain_id)),
    uniq(columns.map((c) => c.code_cls_id)),
  );
  const order = new Map(tableIds.map((id, i) => [id, i]));
  const sorted = [...tables].sort((a, b) => order.get(a.table_id)! - order.get(b.table_id)!);
  return assembleModels({ tables: sorted, columns, bizAreas, ...refs });
}

/** 도메인분류 접미어 집합(W_SUFFIX_UNREGISTERED). */
export async function loadSuffixes(q: ExecQ, projectId: number): Promise<Set<string>> {
  const rows = await rowsOf<{ suffix: string }>(
    q,
    sql`select suffix from std_domain_cls where project_id = ${projectId}`,
  );
  return new Set(rows.map((r) => r.suffix));
}

/**
 * 저장 전 본문(편집기 미리보기, §10.4 `draft`) → 모델. 도메인·코드구분 참조는 **이 프로젝트 소속만** 해석하고
 * 다른 프로젝트 ID는 연결 없음으로 본다(미리보기 — 저장 시 IDOR 422는 T8.2). 업무구분은 호출자가 소속 검사.
 */
export async function draftModel(
  q: ExecQ,
  projectId: number,
  draft: Pick<TableCreateInput, 'table' | 'columns'>,
  bizAreas: readonly BizAreaRow[],
): Promise<TableModel> {
  const uniq = (v: (number | null)[]) => [...new Set(v.filter((x): x is number => x !== null))];
  const refs = await refRows(
    q,
    projectId,
    uniq(draft.columns.map((c) => c.domainId)),
    uniq(draft.columns.map((c) => c.codeClsId)),
  );
  const domains = domainRefs(refs.domains);
  const codes = codeSummaries({ bizAreas, codeClasses: refs.codeClasses, codes: refs.codes });
  const b = bizAreas.find((x) => x.biz_area_id === draft.table.bizAreaId);
  return {
    tableId: null,
    tableNm: draft.table.tableNm,
    logicalNm: draft.table.tableLogicalNm,
    description: draft.table.description,
    bizAreaId: b?.biz_area_id ?? null,
    bizCd: b?.biz_cd ?? null,
    bizNm: b?.biz_nm ?? null,
    tablePrefix: b?.table_prefix ?? null,
    status: null,
    version: null,
    columns: draft.columns
      .map((c: ColumnInput, i) =>
        toColumnModel(
          {
            column_id: c.columnId ?? 0,
            table_id: 0,
            col_seq: i + 1,
            logical_nm: c.logicalNm,
            physical_nm: c.physicalNm,
            is_pk: c.isPk,
            data_type: c.dataType,
            data_length: c.dataLength,
            data_scale: c.dataScale,
            is_nullable: c.isNullable,
            default_val: c.defaultVal,
            col_comment: c.colComment,
            domain_id: c.domainId,
            code_cls_id: c.codeClsId,
            default_col_id: c.defaultColId,
            match_type: c.matchType,
          },
          domains,
          codes,
        ),
      )
      .map((m, i) => ({ ...m, columnId: draft.columns[i]!.columnId })),
  };
}
