import type { MatchType, StdType, TableStatus } from '@termflow/shared';

/**
 * DDL 생성 입력 모델(설계서 §6.1 "TableModel 조립: prj_table + prj_column + 코드 요약(D14)").
 * DB 접근 없는 순수 값 — 생성기·검증기·정보 추출이 같은 모델을 받는다(골든 파일 비교 가능, F2).
 */
export interface CodeSummary {
  codeClsId: number;
  bizCd: string;
  codeCls: string;
  codeClsNm: string;
  /** 활성 코드만, 정렬 = `sort_order nulls last, code`(코드 화면과 같은 순서, CR-05 §4). */
  codes: { code: string; codeNm: string }[];
}

export interface DomainRef {
  domainId: number;
  logicalNm: string;
  colType: StdType | null;
  colLength: number | null;
  colScale: number | null;
  reviewYn: boolean;
}

export interface ColumnModel {
  columnId: number | null;
  colSeq: number;
  logicalNm: string;
  physicalNm: string;
  isPk: boolean;
  dataType: StdType | null;
  dataLength: number | null;
  dataScale: number | null;
  isNullable: boolean;
  defaultVal: string | null;
  colComment: string | null;
  domainId: number | null;
  codeClsId: number | null;
  defaultColId: number | null;
  matchType: MatchType;
  /** 연결 도메인(재검증 W_DOMAIN_*). 없으면 null. */
  domain: DomainRef | null;
  /** 연결 코드구분 요약(D14). code_cls_id가 없거나 삭제됐으면 null. */
  codeClsRef: CodeSummary | null;
}

export interface TableModel {
  /** 저장 전 미리보기(draft)면 null. */
  tableId: number | null;
  tableNm: string;
  logicalNm: string;
  description: string | null;
  bizAreaId: number | null;
  bizCd: string | null;
  bizNm: string | null;
  tablePrefix: string | null;
  status: TableStatus | null;
  version: number | null;
  columns: ColumnModel[];
}

/** 헤더 주석(§6.2 header(meta)): 생성일시·프로젝트·방언·생성자. 골든 파일은 고정 값을 쓴다. */
export interface DdlMeta {
  projectKey: string;
  projectNm: string;
  /** `yyyy-MM-dd HH:mm`(서버 로컬). */
  generatedAt: string;
  generatedBy: string;
}
