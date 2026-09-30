import type { StdType, TermStatus } from '@termflow/shared';
import { buildSnapshot, type TermSnapshot } from '../../src/autocomplete/term-snapshot.js';

/**
 * 자동완성 단위 테스트용 합성 스냅샷(설계서 §5.3~§5.6 예시 그대로: 연구=RSCH, 과제=PRJ, 번호=NO, 마스터=MST, 구분=TP …).
 * 실데이터(승계 649 논리명)는 `test/db/autocomplete-rms.test.ts`·벤치가 쓴다.
 */
export const TERMS: [string, string | null, TermStatus?][] = [
  ['연구', 'RSCH'],
  ['과제', 'PRJ'],
  ['번호', 'NO'],
  ['마스터', 'MST'],
  ['구분', 'TP'],
  ['코드', 'CD'],
  ['상태', 'STAT'],
  ['진행', 'PRGRS'],
  ['명', 'NM'],
  ['ID', 'ID'],
  ['접수', 'RCPT'],
  ['일자', 'DT'],
  ['일시', 'DTS'],
  ['관리', 'MNGT'],
  ['라벨', 'LABEL'],
  ['칸', 'KAN'],
  ['정보', 'INFO'],
  ['금액', 'AMT'],
  ['예산', 'BUDG'],
  ['검토', 'RVIEW', 'PENDING'],
  ['응답', 'RESP'],
  ['분류', 'CLS'],
  ['무효', null],
  ['책임자', 'MGR', 'REJECTED'],
];

export type Dom = [
  logical: string,
  physical: string | null,
  suffix: string | null,
  type: StdType | null,
  len: number | null,
  review?: boolean,
];
export const DOMAINS: Dom[] = [
  ['연구과제ID', 'RSCH_PRJ_ID', 'ID', 'VARCHAR', 20],
  ['연구과제명', 'RSCH_PRJ_NM', 'NM', 'VARCHAR', 30],
  ['과제접수일자', 'PRJ_RCPT_DT', 'DT', 'VARCHAR', 8],
  ['접수일시', 'RCPT_DTS', 'DTS', 'TIMESTAMP', 0],
  ['접수번호', 'RCPT_NO', 'NO', 'VARCHAR', 20],
  ['접수구분', 'RCPT_TP', 'TP', 'VARCHAR', 10],
  ['연구과제관리번호', 'RSCH_PRJ_MNGT_NO', 'NO', 'VARCHAR', 20],
  ['검토의견', null, null, null, null, true],
  ['예산금액', 'BUDG_AMT', 'AMT', 'BIGINT', null, true],
  ['과제상태코드', 'PRJ_STAT_CD', 'CD', 'VARCHAR', 10],
];

export const CLS: [string, StdType, number | null, number | null][] = [
  ['NO', 'VARCHAR', 20, null],
  ['ID', 'VARCHAR', 20, null],
  ['NM', 'VARCHAR', 30, null],
  ['TP', 'VARCHAR', 10, null],
  ['CD', 'VARCHAR', 10, null],
  ['DT', 'VARCHAR', 8, null],
  ['DTS', 'TIMESTAMP', 0, null],
  ['AMT', 'BIGINT', null, null],
  ['MST', 'VARCHAR', 20, null],
];

/** 업무구분: RP(1, 접두어 RP_) · PS(2, PS_) · CM(3, 접두어 없음). */
export const BIZ = [
  { biz_area_id: 1, biz_cd: 'RP', biz_nm: '연구과제', table_prefix: 'RP_', use_yn: true },
  { biz_area_id: 2, biz_cd: 'PS', biz_nm: '인사', table_prefix: 'PS_', use_yn: true },
  { biz_area_id: 3, biz_cd: 'CM', biz_nm: '공통', table_prefix: null, use_yn: true },
];

export const CODE_CLS: [id: number, biz: number, cls: string, nm: string, cnt: number][] = [
  [11, 1, '040', '진행상태', 5],
  [12, 2, '023', '상태', 3],
  [13, 1, '041', '연구과제상태', 4],
  [14, 1, '042', '과제상태', 2],
  [15, 2, '060', '연구과제상태구분', 2],
];

export function makeSnapshot(
  extra: { terms?: typeof TERMS; domains?: Dom[] } = {},
  projectId = 1,
): TermSnapshot {
  const terms = [...TERMS, ...(extra.terms ?? [])];
  const domains = [...DOMAINS, ...(extra.domains ?? [])];
  return buildSnapshot(projectId, {
    terms: terms.map(([kor, phys, status], i) => ({
      term_id: 100 + i,
      term_kor: kor,
      term_physical: phys,
      status: status ?? 'APPROVED',
    })),
    domains: domains.map(([logical, physical, suffix, type, len, review], i) => ({
      domain_id: 1000 + i,
      logical_nm: logical,
      physical_nm: physical,
      suffix,
      domain_cls_id: suffix ? 50 : null,
      col_type: type,
      col_length: len,
      col_scale: null,
      review_yn: review ?? false,
    })),
    cls: CLS.map(([suffix, t, len, scale], i) => ({
      domain_cls_id: 50 + i,
      suffix,
      col_type: t,
      col_length: len,
      col_scale: scale,
    })),
    codeCls: CODE_CLS.map(([id, biz, cls, nm, cnt]) => {
      const b = BIZ.find((x) => x.biz_area_id === biz)!;
      return {
        code_cls_id: id,
        biz_area_id: biz,
        biz_cd: b.biz_cd,
        biz_nm: b.biz_nm,
        code_cls: cls,
        code_cls_nm: nm,
        code_cnt: cnt,
        codes: [{ code: '01', codeNm: '접수' }],
      };
    }),
    bizAreas: BIZ,
  });
}
