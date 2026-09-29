import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  SEARCH_RESULTS_PER_KIND,
  typeText,
  type SearchResponse,
  type StdType,
  type TermStatus,
} from '@termflow/shared';
import type { ProjectCtx } from '../common/project-context.js';
import type { Db } from '../db/client.js';
import { DRIZZLE } from '../db/db.module.js';
import { likePattern, rowsOf } from './std-sql.js';

/**
 * 전역 검색(T6.10, 설계서 §10.2 상단 바, §9.3 `P/search`) — **현재 프로젝트 범위만**(CR-01 6절). 종류별 최대 5건,
 * 정확 일치 → 앞부분 일치 → 부분 일치 순. 테이블은 T7.9에서 추가(지금은 빈 배열).
 */
@Injectable()
export class SearchService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async search(ctx: ProjectCtx, q: string): Promise<SearchResponse> {
    const term = q.trim();
    const like = likePattern(term);
    const prefix = `${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const up = term.toUpperCase();
    const [terms, domains] = await Promise.all([
      rowsOf<{
        term_id: number;
        term_kor: string;
        term_physical: string | null;
        status: TermStatus;
      }>(
        this.db,
        sql`select term_id, term_kor, term_physical, status from std_term
             where project_id = ${ctx.projectId} and (term_kor ilike ${like} or term_physical ilike ${like})
             order by case when term_kor = ${term} or term_physical = ${up} then 0
                           when term_kor like ${prefix} or term_physical like ${prefix.toUpperCase()} then 1 else 2 end,
                      length(term_kor), term_kor
             limit ${SEARCH_RESULTS_PER_KIND}`,
      ),
      rowsOf<{
        domain_id: number;
        logical_nm: string;
        physical_nm: string | null;
        col_type: StdType | null;
        col_length: number | null;
        col_scale: number | null;
        review_yn: boolean;
      }>(
        this.db,
        sql`select domain_id, logical_nm, physical_nm, col_type, col_length, col_scale, review_yn from std_domain
             where project_id = ${ctx.projectId} and (logical_nm ilike ${like} or physical_nm ilike ${like})
             order by case when logical_nm = ${term} or physical_nm = ${up} then 0
                           when logical_nm like ${prefix} or physical_nm like ${prefix.toUpperCase()} then 1 else 2 end,
                      length(logical_nm), logical_nm
             limit ${SEARCH_RESULTS_PER_KIND}`,
      ),
    ]);
    return {
      terms: terms.map((t) => ({
        termId: t.term_id,
        termKor: t.term_kor,
        termPhysical: t.term_physical,
        status: t.status,
      })),
      domains: domains.map((d) => ({
        domainId: d.domain_id,
        logicalNm: d.logical_nm,
        physicalNm: d.physical_nm,
        typeText: typeText(d.col_type, d.col_length, d.col_scale),
        reviewYn: d.review_yn,
      })),
      tables: [],
    };
  }
}
