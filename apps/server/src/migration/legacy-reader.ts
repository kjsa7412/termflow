import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { Tx } from './context.js';

/**
 * legacy 스키마 읽기(원본 그대로). 일시는 문자열(`YYYY-MM-DD HH24:MI:SS`)로 받아 R13에서 그대로 쓴다
 * (Date 변환에 따른 시간대 이동 방지). 정렬은 원본 키 순서, 코드는 적재 순서(ctid = dump INSERT 순).
 */
type Q = Db | Tx;

async function rows<T>(q: Q, query: SQL): Promise<T[]> {
  const r = await q.execute(query);
  return r.rows as T[];
}

const ts = (col: string) => sql`to_char(${sql.identifier(col)}, 'YYYY-MM-DD HH24:MI:SS')`;

export interface LegacyTerm {
  term_id: number;
  term_kor: string;
  term_physical: string | null;
  description: string | null;
  same_nm_ref: string | null;
  firs_reg_dts: string | null;
  fina_reg_dts: string | null;
}
export const readTerms = (q: Q) =>
  rows<LegacyTerm>(
    q,
    sql`select term_id, term_kor, term_physical, description, same_nm_ref,
               ${ts('firs_reg_dts')} as firs_reg_dts, ${ts('fina_reg_dts')} as fina_reg_dts
          from legacy.tb_term_dict order by term_id`,
  );

export interface LegacyDomainCls {
  suffix: string;
  cls_nm: string;
  col_type: string;
  col_length: string | null;
  remark: string | null;
  firs_reg_dts: string | null;
  fina_reg_dts: string | null;
}
export const readDomainCls = (q: Q) =>
  rows<LegacyDomainCls>(
    q,
    sql`select suffix, cls_nm, col_type, col_length, remark,
               ${ts('firs_reg_dts')} as firs_reg_dts, ${ts('fina_reg_dts')} as fina_reg_dts
          from legacy.tb_domain_cls order by suffix`,
  );

export interface LegacyDomain {
  domain_id: number;
  nm1: string | null;
  nm2: string | null;
  nm3: string | null;
  nm4: string | null;
  nm5: string | null;
  nm6: string | null;
  nm7: string | null;
  logical_nm: string;
  physical_nm: string | null;
  descr: string | null;
  suffix: string | null;
  col_type: string | null;
  col_length: string | null;
  col_type_manual: string | null;
  firs_reg_dts: string | null;
  fina_reg_dts: string | null;
}
export const readDomains = (q: Q) =>
  rows<LegacyDomain>(
    q,
    sql`select domain_id, nm1, nm2, nm3, nm4, nm5, nm6, nm7, logical_nm, physical_nm, descr, suffix,
               col_type, col_length, col_type_manual,
               ${ts('firs_reg_dts')} as firs_reg_dts, ${ts('fina_reg_dts')} as fina_reg_dts
          from legacy.tb_domain order by domain_id`,
  );

export interface LegacyCode {
  biz_cls: string;
  biz_cls_nm: string;
  code_cls: string;
  code_cls_nm: string;
  code: string;
  code_nm: string;
  seq: number;
  firs_reg_dts: string | null;
  fina_reg_dts: string | null;
}
/** seq = 코드구분 안의 원본 적재 순서(1부터). */
export const readCodes = (q: Q) =>
  rows<LegacyCode>(
    q,
    sql`select biz_cls, biz_cls_nm, code_cls, code_cls_nm, code, code_nm,
               (row_number() over (partition by biz_cls, code_cls order by ctid))::int as seq,
               ${ts('firs_reg_dts')} as firs_reg_dts, ${ts('fina_reg_dts')} as fina_reg_dts
          from legacy.tb_code_info order by ctid`,
  );

export interface LegacyDefaultCol {
  col_seq: number;
  logical_col_nm: string;
  physical_col_nm: string;
  is_key: string | null;
  data_type: string;
  is_nullable: string | null;
  default_val: string | null;
  col_comment: string | null;
  firs_reg_dts: string | null;
  fina_reg_dts: string | null;
}
export const readDefaultCols = (q: Q) =>
  rows<LegacyDefaultCol>(
    q,
    sql`select col_seq, logical_col_nm, physical_col_nm, is_key, data_type, is_nullable, default_val, col_comment,
               ${ts('firs_reg_dts')} as firs_reg_dts, ${ts('fina_reg_dts')} as fina_reg_dts
          from legacy.tb_default_col order by col_seq`,
  );
