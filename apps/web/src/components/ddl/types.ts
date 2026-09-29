import type { TableStatus } from '@termflow/shared';

/** 내보내기 선택 테이블 1행(목업 10 좌측 카드). 생성 순서 = 파일 안 순서(§6.10 "사용자가 정렬한 순서"). */
export interface SelItem {
  tableId: number;
  tableNm: string;
  logicalNm: string;
  colCnt: number;
  status: TableStatus | null;
  bizCd: string | null;
  warningCnt?: number;
  errorCnt?: number;
}
