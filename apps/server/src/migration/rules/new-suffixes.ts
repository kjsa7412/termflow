import type { StdType } from '@termflow/shared';

/**
 * 도메인분류 신규 접미어 30종(설계서 §11.6, D12). 제안 타입을 그대로 채택(권장안 자동 채택, 사용자 지시).
 * 설계서가 '검토'로 표시한 8종은 `review_yn=TRUE`로 적재해 관리자 정정 목록(RK1)에 올린다.
 */
export interface NewSuffix {
  suffix: string;
  clsNm: string;
  colType: StdType;
  colLength: number | null;
  colScale: number | null;
  review: boolean;
  note: string;
}

const s = (
  suffix: string,
  clsNm: string,
  colType: StdType,
  colLength: number | null,
  colScale: number | null,
  note: string,
  review = false,
): NewSuffix => ({ suffix, clsNm, colType, colLength, colScale, review, note });

export const NEW_SUFFIXES: readonly NewSuffix[] = [
  s('INFO', '정보', 'VARCHAR', 200, null, 'DESC(100)보다 넓은 서술. 검토: 코드성 여부', true),
  s('POINT', '포인트', 'BIGINT', null, null, 'MILG(마일리지) BIGINT와 동일 성격'),
  s('LSTYY', '최종년도', 'VARCHAR', 4, null, 'YY(년) 규칙'),
  s('SLS', '매출', 'BIGINT', null, null, 'AMT 계열'),
  s('RESN', '사유', 'VARCHAR', 200, null, '서술형'),
  s('MSMT', '측정값', 'NUMERIC', 10, 2, '검토: 단위·정밀도', true),
  s('SHOP', '매장', 'VARCHAR', 10, null, '코드성(CD) 추정. 검토', true),
  s('SIZE', '사이즈', 'VARCHAR', 10, null, '의류 사이즈 문자열'),
  s('STAT', '상태', 'VARCHAR', 10, null, 'CD 규칙(상태코드)'),
  s('KIND', '종류', 'VARCHAR', 10, null, 'CD 규칙'),
  s('CRYY', '기준년도', 'VARCHAR', 4, null, 'YY 규칙'),
  s('SHP', '배송', 'VARCHAR', 20, null, '검토: 배송번호(NO)인지 코드인지', true),
  s('PART', '부품, 파트', 'VARCHAR', 20, null, '검토', true),
  s('CTG', '카테고리', 'VARCHAR', 10, null, 'CD 규칙'),
  s('ITEM', '품목', 'VARCHAR', 20, null, '품목코드 추정'),
  s('BRND', '브랜드', 'VARCHAR', 10, null, 'CD 규칙'),
  s('JGMT', '판정', 'VARCHAR', 10, null, 'CD 규칙'),
  s('PSBL', '가능', 'VARCHAR', 1, null, 'YN 규칙'),
  s('PRD', '기간, 상품', 'VARCHAR', 20, null, '검토: 두 의미 혼재 가능', true),
  s('BIZD', '사업부', 'VARCHAR', 10, null, 'CD 규칙'),
  s('GRD', '등급', 'VARCHAR', 10, null, 'CD 규칙'),
  s('AUTH', '권한', 'VARCHAR', 10, null, 'CD 규칙'),
  s('SLIP', '전표', 'VARCHAR', 20, null, 'NO 규칙(전표번호)'),
  s('STD', '기준', 'VARCHAR', 20, null, '검토', true),
  s('WORD', '단어, 문구', 'VARCHAR', 100, null, '서술형'),
  s('BCODE', '바코드', 'VARCHAR', 30, null, '바코드 길이 여유'),
  s('TNOP', '총인원', 'INT', null, null, 'CNT 규칙'),
  s('STYLE', '스타일', 'VARCHAR', 20, null, '스타일코드 추정'),
  s('WKN', '주차', 'SMALLINT', null, null, 'ORD·YCNT 규칙'),
  s('WGHT', '중량', 'NUMERIC', 10, 2, '검토: 단위', true),
];
