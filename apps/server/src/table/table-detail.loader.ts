import { sql } from 'drizzle-orm';
import type {
  HistoryAction,
  MatchType,
  StdType,
  TableColumnItem,
  TableHeaderItem,
  TableSnapshot,
  TableSnapshotColumn,
  TableStatus,
} from '@termflow/shared';
import { isoTs, rowsOf, type ExecQ } from '../project/sql-util.js';
import type { ExistingColumn } from './column-diff.js';

/**
 * 편집기 조회(GET P/tables/{id}, 409 `current`)와 스냅샷(§8.3) 조립. 모든 조회는 `project_id`로 한정(§9.1).
 */
interface HeaderRow {
  table_id: number;
  biz_area_id: number;
  biz_cd: string;
  biz_nm: string;
  table_prefix: string | null;
  biz_use_yn: boolean;
  table_nm: string;
  table_logical_nm: string;
  description: string | null;
  status: TableStatus;
  version: number;
  finalized_at: string | null;
  finalized_by: string | null;
  review_yn: boolean;
  review_note: string | null;
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_by_nm: string | null;
  updated_at: string;
}

interface ColumnRow {
  column_id: number;
  col_seq: number;
  logical_nm: string;
  physical_nm: string;
  is_pk: boolean;
  data_type: StdType | null;
  data_length: number | null;
  data_scale: number | null;
  is_nullable: boolean;
  default_val: string | null;
  col_comment: string | null;
  domain_id: number | null;
  code_cls_id: number | null;
  default_col_id: number | null;
  match_type: MatchType;
  domain_nm: string | null;
  cc_biz_cd: string | null;
  cc_code_cls: string | null;
  cc_code_cls_nm: string | null;
}

export async function loadHeader(
  q: ExecQ,
  projectId: number,
  projectKey: string,
  tableId: number,
): Promise<TableHeaderItem | null> {
  const [r] = await rowsOf<HeaderRow>(
    q,
    sql`select t.table_id, t.biz_area_id, b.biz_cd, b.biz_nm, b.table_prefix, b.use_yn biz_use_yn,
               t.table_nm, t.table_logical_nm, t.description, t.status, t.version,
               ${isoTs(sql`t.finalized_at`)} finalized_at, t.finalized_by, t.review_yn, t.review_note,
               t.created_by, ${isoTs(sql`t.created_at`)} created_at, t.updated_by, u.user_nm updated_by_nm,
               ${isoTs(sql`t.updated_at`)} updated_at
          from prj_table t
          join prj_biz_area b on b.biz_area_id = t.biz_area_id
          left join tf_user u on u.login_id = t.updated_by
         where t.project_id = ${projectId} and t.table_id = ${tableId}`,
  );
  if (!r) return null;
  return {
    tableId: r.table_id,
    projectKey,
    bizAreaId: r.biz_area_id,
    bizCd: r.biz_cd,
    bizNm: r.biz_nm,
    tablePrefix: r.table_prefix,
    bizUseYn: r.biz_use_yn,
    tableNm: r.table_nm,
    tableLogicalNm: r.table_logical_nm,
    description: r.description,
    status: r.status,
    version: r.version,
    finalizedAt: r.finalized_at,
    finalizedBy: r.finalized_by,
    reviewYn: r.review_yn,
    reviewNote: r.review_note,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedBy: r.updated_by,
    updatedByNm: r.updated_by_nm,
    updatedAt: r.updated_at,
  };
}

export async function loadColumns(
  q: ExecQ,
  projectId: number,
  tableId: number,
): Promise<TableColumnItem[]> {
  const rows = await rowsOf<ColumnRow>(
    q,
    sql`select c.column_id, c.col_seq, c.logical_nm, c.physical_nm, c.is_pk, c.data_type, c.data_length, c.data_scale,
               c.is_nullable, c.default_val, c.col_comment, c.domain_id, c.code_cls_id, c.default_col_id, c.match_type,
               d.logical_nm domain_nm, cb.biz_cd cc_biz_cd, cc.code_cls cc_code_cls, cc.code_cls_nm cc_code_cls_nm
          from prj_column c
          left join std_domain d on d.domain_id = c.domain_id and d.project_id = c.project_id
          left join std_code_cls cc on cc.code_cls_id = c.code_cls_id and cc.project_id = c.project_id
          left join prj_biz_area cb on cb.biz_area_id = cc.biz_area_id
         where c.project_id = ${projectId} and c.table_id = ${tableId}
         order by c.col_seq`,
  );
  return rows.map((r) => ({
    columnId: r.column_id,
    colSeq: r.col_seq,
    logicalNm: r.logical_nm,
    physicalNm: r.physical_nm,
    isPk: r.is_pk,
    dataType: r.data_type,
    dataLength: r.data_length,
    dataScale: r.data_scale,
    isNullable: r.is_nullable,
    defaultVal: r.default_val,
    colComment: r.col_comment,
    domainId: r.domain_id,
    codeClsId: r.code_cls_id,
    defaultColId: r.default_col_id,
    matchType: r.match_type,
    domainNm: r.domain_nm,
    codeCls:
      r.code_cls_id !== null && r.cc_code_cls !== null
        ? {
            codeClsId: r.code_cls_id,
            bizCd: r.cc_biz_cd ?? '?',
            codeCls: r.cc_code_cls,
            codeClsNm: r.cc_code_cls_nm ?? '',
          }
        : null,
  }));
}

/** diff 입력(§8.2 existing). */
export function toExisting(c: TableColumnItem): ExistingColumn {
  return {
    columnId: c.columnId,
    colSeq: c.colSeq,
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
  };
}

export function snapshotColumn(c: TableColumnItem): TableSnapshotColumn {
  const { domainNm: _d, codeCls: _c, ...rest } = c;
  return rest;
}

/** 스냅샷(§8.3 schemaVersion 1). 저장 성공 트랜잭션 안에서 저장 후 상태로 만든다. */
export function buildSnapshot(
  header: TableHeaderItem,
  columns: readonly TableColumnItem[],
  meta: {
    action: HistoryAction;
    changeSummary: string | null;
    savedBy: string;
    extra?: Pick<TableSnapshot, 'clonedFrom' | 'restoredFrom' | 'note'>;
  },
): TableSnapshot {
  return {
    schemaVersion: 1,
    table: {
      tableId: header.tableId,
      projectKey: header.projectKey,
      bizCd: header.bizCd,
      bizAreaId: header.bizAreaId,
      tableNm: header.tableNm,
      tableLogicalNm: header.tableLogicalNm,
      description: header.description,
      status: header.status,
      version: header.version,
    },
    columns: columns.map(snapshotColumn),
    action: meta.action,
    changeSummary: meta.changeSummary,
    savedBy: meta.savedBy,
    savedAt: header.updatedAt,
    ...(meta.extra ?? {}),
  };
}

/**
 * 스냅샷 읽기(§8.3 "schemaVersion으로 판별, 읽기 시 하위 호환 변환"). 현재 1판뿐 — schemaVersion이 없는 행(초기 승계)은
 * 1판으로 보고 빠진 필드를 기본값으로 채운다. 모르는 판은 오류(새 서버가 필요).
 */
export function readSnapshot(raw: unknown): TableSnapshot {
  const s = (raw ?? {}) as Partial<TableSnapshot> & { schemaVersion?: number };
  const v = s.schemaVersion ?? 1;
  if (v !== 1) throw new Error(`알 수 없는 스냅샷 schemaVersion: ${v}`);
  const cols = (s.columns ?? []).map((c, i): TableSnapshotColumn => ({
    columnId: c.columnId ?? null,
    colSeq: c.colSeq ?? i + 1,
    logicalNm: c.logicalNm ?? '',
    physicalNm: c.physicalNm ?? '',
    isPk: c.isPk ?? false,
    dataType: c.dataType ?? null,
    dataLength: c.dataLength ?? null,
    dataScale: c.dataScale ?? null,
    isNullable: c.isNullable ?? true,
    defaultVal: c.defaultVal ?? null,
    colComment: c.colComment ?? null,
    domainId: c.domainId ?? null,
    codeClsId: c.codeClsId ?? null,
    defaultColId: c.defaultColId ?? null,
    matchType: c.matchType ?? 'MANUAL',
  }));
  return {
    ...(s as TableSnapshot),
    schemaVersion: 1,
    columns: cols,
    changeSummary: s.changeSummary ?? null,
  };
}
