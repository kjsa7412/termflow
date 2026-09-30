import { sql } from 'drizzle-orm';
import { normalizeLogical, typeText, type StdType, type TermStatus } from '@termflow/shared';
import { rowsOf, type ExecQ } from '../project/sql-util.js';
import type { DomainClsEntry, L1Snapshot } from './domain-calculator.js';
import type { SegDict, SegTerm } from './segmenter.js';

/**
 * 프로젝트 1개의 자동완성 스냅샷(설계서 §5.1, 불변). `TermCacheRegistry`가 지연 로드·LRU로 관리한다.
 * L1Snapshot(도메인 자동계산 입력)과 SegDict(분절 사전)를 함께 만족한다 — 규칙 단일 구현(§2.5.9).
 */
export interface SnapTerm extends SegTerm {
  readonly physical: string;
  readonly termId: number;
  readonly status: Extract<TermStatus, 'APPROVED' | 'PENDING'>;
}

export interface SnapDomain {
  readonly domainId: number;
  /** 원래 논리명(표시). */
  readonly logicalNm: string;
  /** 정규화 논리명(검색 키, `normalizeLogical`). */
  readonly key: string;
  readonly physicalNm: string | null;
  readonly suffix: string | null;
  readonly domainClsId: number | null;
  readonly colType: StdType | null;
  readonly colLength: number | null;
  readonly colScale: number | null;
  readonly typeText: string | null;
  readonly reviewYn: boolean;
}

export interface SnapCodeCls {
  readonly codeClsId: number;
  readonly bizAreaId: number;
  readonly bizCd: string;
  readonly bizNm: string;
  readonly codeCls: string;
  readonly codeClsNm: string;
  /** 정규화 코드구분명(공백 제거·NFC·라틴 대문자). */
  readonly key: string;
  readonly codeCnt: number;
  /** 앞 5개 코드(후보 미리보기, 정렬순). */
  readonly codes: readonly { code: string; codeNm: string }[];
}

export interface SnapBizArea {
  readonly bizAreaId: number;
  readonly bizCd: string;
  readonly bizNm: string;
  readonly tablePrefix: string | null;
  readonly useYn: boolean;
}

export interface TermSnapshot extends L1Snapshot, SegDict {
  readonly projectId: number;
  readonly termByKor: ReadonlyMap<string, SnapTerm>;
  /** 반려 용어(자동완성 제외 — W_TERM_REJECTED 판정용). */
  readonly rejectedKor: ReadonlySet<string>;
  readonly maxLen: number;
  readonly domainByLogical: ReadonlyMap<string, SnapDomain>;
  /** 유사 검색 대상(logical_nm 정렬, physical 있는 것만). */
  readonly domains: readonly SnapDomain[];
  readonly clsBySuffix: ReadonlyMap<string, DomainClsEntry>;
  readonly codeClsList: readonly SnapCodeCls[];
  readonly bizAreas: ReadonlyMap<number, SnapBizArea>;
  readonly counts: {
    terms: number;
    rejected: number;
    domains: number;
    domainCls: number;
    codeCls: number;
    bizAreas: number;
  };
}

/** 논리명 정규화(§5.3) — 편집기와 공유(`@termflow/shared`). */
export { normalizeLogical };

interface TermRow {
  term_id: number;
  term_kor: string;
  term_physical: string | null;
  status: TermStatus;
}
interface DomainRow {
  domain_id: number;
  logical_nm: string;
  physical_nm: string | null;
  suffix: string | null;
  domain_cls_id: number | null;
  col_type: StdType | null;
  col_length: number | null;
  col_scale: number | null;
  review_yn: boolean;
}
interface ClsRow {
  domain_cls_id: number;
  suffix: string;
  col_type: StdType;
  col_length: number | null;
  col_scale: number | null;
}
interface CodeClsRow {
  code_cls_id: number;
  biz_area_id: number;
  biz_cd: string;
  biz_nm: string;
  code_cls: string;
  code_cls_nm: string;
  code_cnt: number;
  codes: { code: string; codeNm: string }[] | null;
}
interface BizRow {
  biz_area_id: number;
  biz_cd: string;
  biz_nm: string;
  table_prefix: string | null;
  use_yn: boolean;
}

/** 조회 결과 행 → 스냅샷(순수 — 단위 테스트는 행을 직접 준다). */
export function buildSnapshot(
  projectId: number,
  rows: {
    terms: readonly TermRow[];
    domains: readonly DomainRow[];
    cls: readonly ClsRow[];
    codeCls: readonly CodeClsRow[];
    bizAreas: readonly BizRow[];
  },
): TermSnapshot {
  const termByKor = new Map<string, SnapTerm>();
  const rejectedKor = new Set<string>();
  let maxLen = 1;
  for (const t of rows.terms) {
    const kor = normalizeLogical(t.term_kor);
    if (t.status === 'REJECTED') {
      rejectedKor.add(kor);
      continue;
    }
    if (!t.term_physical) continue; // physical NULL = 미등록과 같다(§5.2 3단계)
    termByKor.set(kor, { physical: t.term_physical, termId: t.term_id, status: t.status });
    if (kor.length > maxLen) maxLen = kor.length;
  }
  const domains: SnapDomain[] = rows.domains.map((d) => ({
    domainId: d.domain_id,
    logicalNm: d.logical_nm,
    key: normalizeLogical(d.logical_nm),
    physicalNm: d.physical_nm,
    suffix: d.suffix,
    domainClsId: d.domain_cls_id,
    colType: d.col_type,
    colLength: d.col_length,
    colScale: d.col_scale,
    typeText: typeText(d.col_type, d.col_length, d.col_scale),
    reviewYn: d.review_yn,
  }));
  domains.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.domainId - b.domainId));
  const domainByLogical = new Map<string, SnapDomain>();
  for (const d of domains) if (!domainByLogical.has(d.key)) domainByLogical.set(d.key, d);
  const clsBySuffix = new Map<string, DomainClsEntry>(
    rows.cls.map((c) => [
      c.suffix,
      {
        domainClsId: c.domain_cls_id,
        colType: c.col_type,
        colLength: c.col_length,
        colScale: c.col_scale,
      },
    ]),
  );
  const codeClsList: SnapCodeCls[] = rows.codeCls.map((c) => ({
    codeClsId: c.code_cls_id,
    bizAreaId: c.biz_area_id,
    bizCd: c.biz_cd,
    bizNm: c.biz_nm,
    codeCls: c.code_cls,
    codeClsNm: c.code_cls_nm,
    key: normalizeLogical(c.code_cls_nm),
    codeCnt: c.code_cnt,
    codes: c.codes ?? [],
  }));
  const bizAreas = new Map<number, SnapBizArea>(
    rows.bizAreas.map((b) => [
      b.biz_area_id,
      {
        bizAreaId: b.biz_area_id,
        bizCd: b.biz_cd,
        bizNm: b.biz_nm,
        tablePrefix: b.table_prefix,
        useYn: b.use_yn,
      },
    ]),
  );
  return {
    projectId,
    termByKor,
    rejectedKor,
    maxLen,
    get: (kor: string) => termByKor.get(kor),
    domainByLogical,
    domains: domains.filter((d) => d.physicalNm !== null),
    clsBySuffix,
    codeClsList,
    bizAreas,
    counts: {
      terms: termByKor.size,
      rejected: rejectedKor.size,
      domains: rows.domains.length,
      domainCls: rows.cls.length,
      codeCls: rows.codeCls.length,
      bizAreas: rows.bizAreas.length,
    },
  };
}

/** 프로젝트 1개 적재(5문장 병렬, 기본 표준 ≈ 6.6k행). 모든 조회는 project_id로 한정(§9.1). */
export async function loadTermSnapshot(q: ExecQ, projectId: number): Promise<TermSnapshot> {
  const [terms, domains, cls, codeCls, bizAreas] = await Promise.all([
    rowsOf<TermRow>(
      q,
      sql`select term_id, term_kor, term_physical, status from std_term where project_id = ${projectId}`,
    ),
    rowsOf<DomainRow>(
      q,
      sql`select domain_id, logical_nm, physical_nm, suffix, domain_cls_id, col_type, col_length, col_scale, review_yn
            from std_domain where project_id = ${projectId}`,
    ),
    rowsOf<ClsRow>(
      q,
      sql`select domain_cls_id, suffix, col_type, col_length, col_scale from std_domain_cls where project_id = ${projectId}`,
    ),
    rowsOf<CodeClsRow>(
      q,
      sql`select c.code_cls_id, c.biz_area_id, b.biz_cd, b.biz_nm, c.code_cls, c.code_cls_nm,
                 (select count(*)::int from std_code x where x.code_cls_id = c.code_cls_id) code_cnt,
                 (select json_agg(json_build_object('code', y.code, 'codeNm', y.code_nm) order by y.sort_order nulls last, y.code)
                    from (select code, code_nm, sort_order from std_code x where x.code_cls_id = c.code_cls_id
                           order by sort_order nulls last, code limit 5) y) codes
            from std_code_cls c join prj_biz_area b on b.biz_area_id = c.biz_area_id
           where c.project_id = ${projectId}`,
    ),
    rowsOf<BizRow>(
      q,
      sql`select biz_area_id, biz_cd, biz_nm, table_prefix, use_yn from prj_biz_area where project_id = ${projectId}`,
    ),
  ]);
  return buildSnapshot(projectId, { terms, domains, cls, codeCls, bizAreas });
}
