import { sql, type SQL } from 'drizzle-orm';
import type { StdCounts } from '@termflow/shared';
import type { Db } from '../db/client.js';

/** execute 전용 실행자(Db 또는 트랜잭션). */
export type ExecQ = Pick<Db, 'execute'>;

/** TIMESTAMP(0) → 서버 로컬 ISO 문자열(§9.1 `2026-09-28T12:30:05`). pg 기본 파서의 Date 변환(시간대 이동)을 피한다. */
export const isoTs = (col: SQL): SQL => sql`to_char(${col}, 'YYYY-MM-DD"T"HH24:MI:SS')`;

export async function rowsOf<T>(q: ExecQ, query: SQL): Promise<T[]> {
  const r = await q.execute(query);
  return r.rows as T[];
}

/** LIKE 검색어 이스케이프(`\`, `%`, `_`). */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export const EMPTY_COUNTS: StdCounts = {
  bizArea: 0,
  term: 0,
  termApproved: 0,
  domainCls: 0,
  domain: 0,
  codeCls: 0,
  code: 0,
  defaultColSet: 0,
  defaultCol: 0,
};

/** 프로젝트별 업무구분·표준 사전 건수(마법사 원본 후보·템플릿 목록). 테이블당 group by 1문장. */
export async function stdCountsOf(q: ExecQ, ids: number[]): Promise<Map<number, StdCounts>> {
  const out = new Map<number, StdCounts>(ids.map((id) => [id, { ...EMPTY_COUNTS }]));
  if (ids.length === 0) return out;
  const idArr = sql`${sql.param(ids)}::int[]`;
  const rows = await rowsOf<{ pid: number; k: keyof StdCounts; n: number }>(
    q,
    sql`select project_id pid, 'bizArea' k, count(*)::int n from prj_biz_area where project_id = any(${idArr}) group by 1
        union all select project_id, 'term', count(*)::int from std_term where project_id = any(${idArr}) group by 1
        union all select project_id, 'termApproved', count(*)::int from std_term where project_id = any(${idArr}) and status = 'APPROVED' group by 1
        union all select project_id, 'domainCls', count(*)::int from std_domain_cls where project_id = any(${idArr}) group by 1
        union all select project_id, 'domain', count(*)::int from std_domain where project_id = any(${idArr}) group by 1
        union all select project_id, 'codeCls', count(*)::int from std_code_cls where project_id = any(${idArr}) group by 1
        union all select project_id, 'code', count(*)::int from std_code where project_id = any(${idArr}) group by 1
        union all select project_id, 'defaultColSet', count(*)::int from std_default_col_set where project_id = any(${idArr}) group by 1
        union all select project_id, 'defaultCol', count(*)::int from std_default_col where project_id = any(${idArr}) group by 1`,
  );
  for (const r of rows) {
    const c = out.get(r.pid);
    if (c) c[r.k] = r.n;
  }
  return out;
}
