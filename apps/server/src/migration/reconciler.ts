import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { findProjectId, RMS, STDV1, type Tx } from './context.js';
import { NEW_SUFFIXES } from './rules/new-suffixes.js';

/**
 * 대사(설계서 §11.4, G7: 원본 = 적재 + 제외). 1차 범위(단계 3)는 legacy ↔ STDV1.
 * RMS가 없으면 RMS 열·테이블/컬럼 행은 N/A로 기록한다(단계 5에서 STDV1 ↔ RMS 대사 추가).
 * 집합 비교는 정규화 키(R1 정수 표기·trim)로 한다 — 개수만 맞고 내용이 다른 경우를 잡는다.
 */
export interface ReconcileRow {
  item: string;
  legacyCnt: number;
  excludedCnt: number;
  stdv1Cnt: number;
  rmsCnt: number | null;
  flaggedCnt: number;
  check: string;
  result: 'OK' | 'MISMATCH' | 'N/A';
  note: string;
}

type Q = Db | Tx;

async function one<T>(q: Q, query: ReturnType<typeof sql>): Promise<T> {
  const r = await q.execute(query);
  return r.rows[0] as T;
}

/** 두 집합 차이(양쪽 모두) 건수와 예시. */
async function setDiff(
  q: Q,
  legacySet: ReturnType<typeof sql>,
  targetSet: ReturnType<typeof sql>,
): Promise<{ onlyLegacy: number; onlyTarget: number; sample: string }> {
  const r = await one<{ a: number; b: number; sample: string | null }>(
    q,
    sql`with l as (${legacySet}), t as (${targetSet})
        select (select count(*) from (select k from l except select k from t) x)::int as a,
               (select count(*) from (select k from t except select k from l) y)::int as b,
               (select string_agg(k, ', ') from (select k from (select k from l except select k from t) x1
                  union all select k from (select k from t except select k from l) y1 limit 5) z) as sample`,
  );
  return { onlyLegacy: r.a, onlyTarget: r.b, sample: r.sample ?? '' };
}

const norm = (col: string) =>
  sql`case when trim(${sql.identifier(col)}) ~ '^\\d+\\.0$' then split_part(trim(${sql.identifier(col)}), '.', 1) else trim(${sql.identifier(col)}) end`;

export async function reconcileStdv1(q: Q): Promise<ReconcileRow[]> {
  const pid = await findProjectId(q, STDV1.key);
  const rmsId = await findProjectId(q, RMS.key);
  if (pid === null) throw new Error('STDV1이 없어 대사할 수 없습니다');
  const rows: ReconcileRow[] = [];
  const rmsNa = rmsId === null;
  const push = (r: Omit<ReconcileRow, 'rmsCnt' | 'result'> & { ok: boolean }) =>
    rows.push({
      item: r.item,
      legacyCnt: r.legacyCnt,
      excludedCnt: r.excludedCnt,
      stdv1Cnt: r.stdv1Cnt,
      rmsCnt: null,
      flaggedCnt: r.flaggedCnt,
      check: r.check,
      result: r.ok ? 'OK' : 'MISMATCH',
      note: r.note + (rmsNa ? ' / RMS 미생성(단계 5): N/A' : ''),
    });

  // 업무구분
  {
    const l = await one<{ n: number }>(
      q,
      sql`select count(distinct biz_cls)::int n from legacy.tb_code_info`,
    );
    const t = await one<{ n: number }>(
      q,
      sql`select count(*)::int n from prj_biz_area where project_id = ${pid}`,
    );
    const d = await setDiff(
      q,
      sql`select distinct trim(biz_cls) k from legacy.tb_code_info`,
      sql`select biz_cd k from prj_biz_area where project_id = ${pid}`,
    );
    const ok = l.n === t.n && d.onlyLegacy === 0 && d.onlyTarget === 0;
    push({
      item: '업무구분',
      legacyCnt: l.n,
      excludedCnt: 0,
      stdv1Cnt: t.n,
      flaggedCnt: 0,
      check: 'distinct biz_cls = STDV1 biz_cd 집합',
      ok,
      note: d.sample && `차이: ${d.sample}`,
    });
  }
  // 도메인분류: legacy 54 ⊂ STDV1, STDV1 = legacy + 신규 30
  {
    const l = await one<{ n: number }>(q, sql`select count(*)::int n from legacy.tb_domain_cls`);
    const t = await one<{ n: number; f: number }>(
      q,
      sql`select count(*)::int n, count(*) filter (where review_yn)::int f from std_domain_cls where project_id = ${pid}`,
    );
    const d = await setDiff(
      q,
      sql`select upper(trim(suffix)) k from legacy.tb_domain_cls`,
      sql`select suffix k from std_domain_cls where project_id = ${pid}`,
    );
    const ok =
      d.onlyLegacy === 0 &&
      d.onlyTarget === NEW_SUFFIXES.length &&
      t.n === l.n + NEW_SUFFIXES.length;
    push({
      item: '도메인분류',
      legacyCnt: l.n,
      excludedCnt: 0,
      stdv1Cnt: t.n,
      flaggedCnt: t.f,
      check: `legacy ⊂ STDV1, STDV1 = legacy + 신규 ${NEW_SUFFIXES.length}`,
      ok,
      note: `신규 접미어 ${d.onlyTarget}(검토 표시 ${t.f})${d.onlyLegacy ? `, 누락 ${d.onlyLegacy}` : ''}`,
    });
  }
  // 용어
  {
    const l = await one<{ n: number }>(q, sql`select count(*)::int n from legacy.tb_term_dict`);
    const t = await one<{ n: number; f: number; pn: number }>(
      q,
      sql`select count(*)::int n, count(*) filter (where review_yn)::int f, count(*) filter (where term_physical is null)::int pn from std_term where project_id = ${pid}`,
    );
    const d = await setDiff(
      q,
      sql`select ${norm('term_kor')} k from legacy.tb_term_dict`,
      sql`select term_kor k from std_term where project_id = ${pid}`,
    );
    const ok = l.n === t.n && d.onlyLegacy === 0 && d.onlyTarget === 0;
    push({
      item: '용어',
      legacyCnt: l.n,
      excludedCnt: 0,
      stdv1Cnt: t.n,
      flaggedCnt: t.f,
      check: 'term_kor 집합 동일',
      ok,
      note: `R8 physical NULL ${t.pn}${d.sample ? `, 차이: ${d.sample}` : ''}`,
    });
  }
  // 도메인
  {
    const l = await one<{ n: number }>(q, sql`select count(*)::int n from legacy.tb_domain`);
    const t = await one<{ n: number; f: number; pn: number; tn: number }>(
      q,
      sql`select count(*)::int n, count(*) filter (where review_yn)::int f, count(*) filter (where physical_nm is null)::int pn, count(*) filter (where col_type is null)::int tn from std_domain where project_id = ${pid}`,
    );
    const d = await setDiff(
      q,
      sql`select trim(logical_nm) k from legacy.tb_domain`,
      sql`select logical_nm k from std_domain where project_id = ${pid}`,
    );
    const ok = l.n === t.n && d.onlyLegacy === 0 && d.onlyTarget === 0;
    push({
      item: '도메인',
      legacyCnt: l.n,
      excludedCnt: 0,
      stdv1Cnt: t.n,
      flaggedCnt: t.f,
      check: 'logical_nm 집합 동일',
      ok,
      note: `review ${t.f}(물리명 NULL ${t.pn}, 타입 NULL ${t.tn})${d.sample ? `, 차이: ${d.sample}` : ''}`,
    });
  }
  // 코드구분 / 코드
  {
    const l = await one<{ c: number; n: number }>(
      q,
      sql`select count(distinct (trim(biz_cls), trim(code_cls)))::int c, count(*)::int n from legacy.tb_code_info`,
    );
    const t = await one<{ c: number }>(
      q,
      sql`select count(*)::int c from std_code_cls where project_id = ${pid}`,
    );
    const tc = await one<{ n: number }>(
      q,
      sql`select count(*)::int n from std_code where project_id = ${pid}`,
    );
    const d = await setDiff(
      q,
      sql`select trim(biz_cls) || '.' || trim(code_cls) || '.' || trim(code) k from legacy.tb_code_info`,
      sql`select b.biz_cd || '.' || cc.code_cls || '.' || c.code k from std_code c join std_code_cls cc on cc.code_cls_id = c.code_cls_id join prj_biz_area b on b.biz_area_id = cc.biz_area_id where c.project_id = ${pid}`,
    );
    push({
      item: '코드구분',
      legacyCnt: l.c,
      excludedCnt: 0,
      stdv1Cnt: t.c,
      flaggedCnt: 0,
      check: 'count(distinct biz_cls, code_cls)',
      ok: l.c === t.c,
      note: '',
    });
    push({
      item: '코드',
      legacyCnt: l.n,
      excludedCnt: 0,
      stdv1Cnt: tc.n,
      flaggedCnt: 0,
      check: '(biz_cls, code_cls, code) 집합 동일',
      ok: l.n === tc.n && d.onlyLegacy === 0 && d.onlyTarget === 0,
      note: d.sample && `차이: ${d.sample}`,
    });
  }
  // 기본컬럼
  {
    const l = await one<{ n: number }>(q, sql`select count(*)::int n from legacy.tb_default_col`);
    const t = await one<{ n: number }>(
      q,
      sql`select count(*)::int n from std_default_col where project_id = ${pid}`,
    );
    const d = await setDiff(
      q,
      sql`select upper(trim(physical_col_nm)) k from legacy.tb_default_col`,
      sql`select physical_nm k from std_default_col where project_id = ${pid}`,
    );
    push({
      item: '기본컬럼',
      legacyCnt: l.n,
      excludedCnt: 0,
      stdv1Cnt: t.n,
      flaggedCnt: 0,
      check: '물리명 집합 동일',
      ok: l.n === t.n && d.onlyLegacy === 0 && d.onlyTarget === 0,
      note: '',
    });
  }
  // 테이블 / 컬럼(RMS 소관 — 1차 범위 N/A)
  {
    const l = await one<{ t: number; c: number }>(
      q,
      sql`select (select count(*) from legacy.tb_table_schema)::int t, (select count(*) from legacy.tb_column_schema)::int c`,
    );
    for (const [item, n] of [
      ['테이블', l.t],
      ['컬럼', l.c],
    ] as const) {
      rows.push({
        item,
        legacyCnt: n,
        excludedCnt: 0,
        stdv1Cnt: 0,
        rmsCnt: null,
        flaggedCnt: 0,
        check: 'RMS 적재 건수(step 10)',
        result: 'N/A',
        note: '1차 범위 밖: RMS·step 10은 단계 5',
      });
    }
  }
  return rows;
}
