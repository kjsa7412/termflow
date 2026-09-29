import type { MatchType, StdType, TableStatus } from '@termflow/shared';
import type { CodeSummary, ColumnModel, DomainRef, TableModel } from './model.js';

/**
 * TableModel 조립(설계서 §6.1, T7.7): DB 행(snake_case, 테이블 컬럼명 그대로) → 모델. 순수 함수 —
 * 서비스(1회 조회 결과)와 골든 파일 테스트(`test/seed/rp33.sql`의 JSON 행)가 같은 조립 규칙을 쓴다.
 * 코드 요약(D14)은 활성 코드만, `sort_order nulls last, code` 순서(코드 화면과 같음, CR-05 §4).
 */
export interface TableRow {
  table_id: number;
  biz_area_id: number;
  table_nm: string;
  table_logical_nm: string;
  description: string | null;
  status: TableStatus;
  version: number;
}
export interface BizAreaRow {
  biz_area_id: number;
  biz_cd: string;
  biz_nm: string;
  table_prefix: string | null;
}
export interface ColumnRow {
  column_id: number;
  table_id: number;
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
}
export interface DomainRow {
  domain_id: number;
  logical_nm: string;
  col_type: StdType | null;
  col_length: number | null;
  col_scale: number | null;
  review_yn: boolean;
}
export interface CodeClsRow {
  code_cls_id: number;
  biz_area_id: number;
  code_cls: string;
  code_cls_nm: string;
}
export interface CodeRow {
  code_cls_id: number;
  code: string;
  code_nm: string;
  sort_order: number | null;
  is_active: boolean;
}

export interface ModelRows {
  tables: readonly TableRow[];
  bizAreas: readonly BizAreaRow[];
  columns: readonly ColumnRow[];
  domains: readonly DomainRow[];
  codeClasses: readonly CodeClsRow[];
  codes: readonly CodeRow[];
}

/** 코드 정렬: sort_order nulls last → code(코드 포인트, `collate "C"`와 같은 순서). */
function compareCodes(a: CodeRow, b: CodeRow): number {
  if (a.sort_order !== b.sort_order) {
    if (a.sort_order === null) return 1;
    if (b.sort_order === null) return -1;
    return a.sort_order - b.sort_order;
  }
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

export function codeSummaries(
  rows: Pick<ModelRows, 'bizAreas' | 'codeClasses' | 'codes'>,
): Map<number, CodeSummary> {
  const biz = new Map(rows.bizAreas.map((b) => [b.biz_area_id, b]));
  const byCls = new Map<number, CodeRow[]>();
  for (const c of rows.codes) {
    if (!c.is_active) continue;
    byCls.set(c.code_cls_id, [...(byCls.get(c.code_cls_id) ?? []), c]);
  }
  const out = new Map<number, CodeSummary>();
  for (const cc of rows.codeClasses) {
    out.set(cc.code_cls_id, {
      codeClsId: cc.code_cls_id,
      bizCd: biz.get(cc.biz_area_id)?.biz_cd ?? '?',
      codeCls: cc.code_cls,
      codeClsNm: cc.code_cls_nm,
      codes: (byCls.get(cc.code_cls_id) ?? [])
        .sort(compareCodes)
        .map((c) => ({ code: c.code, codeNm: c.code_nm })),
    });
  }
  return out;
}

export function toColumnModel(
  c: ColumnRow,
  domains: ReadonlyMap<number, DomainRef>,
  codes: ReadonlyMap<number, CodeSummary>,
): ColumnModel {
  return {
    columnId: c.column_id,
    colSeq: c.col_seq,
    logicalNm: c.logical_nm,
    physicalNm: c.physical_nm,
    isPk: c.is_pk,
    dataType: c.data_type,
    dataLength: c.data_length,
    dataScale: c.data_scale,
    isNullable: c.is_nullable,
    defaultVal: c.default_val,
    colComment: c.col_comment,
    domainId: c.domain_id,
    codeClsId: c.code_cls_id,
    defaultColId: c.default_col_id,
    matchType: c.match_type,
    domain: c.domain_id !== null ? (domains.get(c.domain_id) ?? null) : null,
    codeClsRef: c.code_cls_id !== null ? (codes.get(c.code_cls_id) ?? null) : null,
  };
}

export function domainRefs(rows: readonly DomainRow[]): Map<number, DomainRef> {
  return new Map(
    rows.map((d) => [
      d.domain_id,
      {
        domainId: d.domain_id,
        logicalNm: d.logical_nm,
        colType: d.col_type,
        colLength: d.col_length,
        colScale: d.col_scale,
        reviewYn: d.review_yn,
      },
    ]),
  );
}

/** 테이블 행 순서를 유지해 모델을 만든다(컬럼은 col_seq 순). */
export function assembleModels(rows: ModelRows): TableModel[] {
  const biz = new Map(rows.bizAreas.map((b) => [b.biz_area_id, b]));
  const domains = domainRefs(rows.domains);
  const codes = codeSummaries(rows);
  const colsByTable = new Map<number, ColumnRow[]>();
  for (const c of rows.columns)
    colsByTable.set(c.table_id, [...(colsByTable.get(c.table_id) ?? []), c]);
  return rows.tables.map((t) => {
    const b = biz.get(t.biz_area_id);
    return {
      tableId: t.table_id,
      tableNm: t.table_nm,
      logicalNm: t.table_logical_nm,
      description: t.description,
      bizAreaId: t.biz_area_id,
      bizCd: b?.biz_cd ?? null,
      bizNm: b?.biz_nm ?? null,
      tablePrefix: b?.table_prefix ?? null,
      status: t.status,
      version: t.version,
      columns: (colsByTable.get(t.table_id) ?? [])
        .sort((x, y) => x.col_seq - y.col_seq)
        .map((c) => toColumnModel(c, domains, codes)),
    };
  });
}
