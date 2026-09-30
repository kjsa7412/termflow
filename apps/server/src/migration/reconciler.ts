import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { findProjectId, RMS, STDV1, type Tx } from './context.js';
import { NEW_SUFFIXES } from './rules/new-suffixes.js';
import { R19_COLUMN_RENAMES } from './rules/r19-term-unify.js';

/**
 * 대사(설계서 §11.4, G7: 원본 = 적재 + 제외). 1차 범위(단계 3)는 legacy ↔ STDV1.
 * RMS가 있으면 전체 범위(단계 5, T5.11): STDV1 ↔ RMS(`project_copy_log` source_cnt = copied_cnt, origin_id 역조인 0건,
 * 건수 동일) + 테이블·컬럼(legacy 33/649 = RMS, legacy_table_id 매핑, 테이블별 컬럼 수, 참조가 모두 RMS 행).
 * RMS가 없으면 RMS 열·테이블/컬럼 행은 N/A로 기록한다.
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
      note: r.note + (rmsNa ? ' / RMS 미생성: N/A' : ''),
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
    // 원본 이름은 R19(CR-09) 정정을 적용해 비교한다(REG_USER_ID → RGSRT_ID)
    const renamed = sql.join(
      [...R19_COLUMN_RENAMES].map(([from, to]) => sql`when ${from} then ${to}`),
      sql` `,
    );
    const d = await setDiff(
      q,
      sql`select case upper(trim(physical_col_nm)) ${renamed} else upper(trim(physical_col_nm)) end k
            from legacy.tb_default_col`,
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
  if (rmsId !== null) {
    await reconcileRms(q, pid, rmsId, rows);
    return rows;
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
        note: '1차 범위 밖: RMS 생성(COPY_TO_RMS·TABLE) 후 대사',
      });
    }
  }
  return rows;
}

/** 표준 항목 → (테이블, PK, project_copy_log.item). */
const STD_ITEMS: Record<string, { table: string; pk: string; item: string }> = {
  업무구분: { table: 'prj_biz_area', pk: 'biz_area_id', item: 'BIZ_AREA' },
  도메인분류: { table: 'std_domain_cls', pk: 'domain_cls_id', item: 'DOMAIN_CLS' },
  용어: { table: 'std_term', pk: 'term_id', item: 'TERM' },
  도메인: { table: 'std_domain', pk: 'domain_id', item: 'DOMAIN' },
  코드구분: { table: 'std_code_cls', pk: 'code_cls_id', item: 'CODE_CLS' },
  코드: { table: 'std_code', pk: 'code_id', item: 'CODE' },
  기본컬럼: { table: 'std_default_col', pk: 'default_col_id', item: 'DEFAULT_COL' },
};

/**
 * STDV1 ↔ RMS(§11.4 "RMS(복사)" 열) + 테이블·컬럼 행. 표준 7항목: ① RMS 건수 = STDV1 ② 복사 로그 source_cnt = copied_cnt
 * ③ origin_id 역조인(원본 없는 RMS 행) 0건 ④ 도메인은 review 건수 동일(C3 생략: 원본 동일).
 */
async function reconcileRms(q: Q, stdv1: number, rms: number, rows: ReconcileRow[]): Promise<void> {
  for (const row of rows) {
    const m = STD_ITEMS[row.item];
    if (!m) continue;
    const t = sql.identifier(m.table);
    const pk = sql.identifier(m.pk);
    const flag = m.table === 'std_domain' ? sql`count(*) filter (where r.review_yn)::int` : sql`0`;
    const r = await one<{ n: number; orphan: number; f: number }>(
      q,
      sql`select count(*)::int n,
                 count(*) filter (where not exists (select 1 from ${t} s
                                   where s.project_id = ${stdv1} and s.${pk} = r.origin_id))::int orphan,
                 ${flag} f
            from ${t} r where r.project_id = ${rms}`,
    );
    const log = await one<{ s: number; c: number } | undefined>(
      q,
      sql`select l.source_cnt s, l.copied_cnt c from project_copy_log l
           where l.project_id = ${rms} and l.operation = 'CREATE' and l.item = ${m.item}
           order by l.copy_id desc limit 1`,
    );
    const problems: string[] = [];
    if (r.n !== row.stdv1Cnt) problems.push(`RMS ${r.n} ≠ STDV1 ${row.stdv1Cnt}`);
    if (!log) problems.push('복사 로그 없음');
    else if (log.s !== log.c) problems.push(`복사 로그 source ${log.s} ≠ copied ${log.c}`);
    if (r.orphan > 0) problems.push(`원본 없는 RMS 행 ${r.orphan}`);
    if (m.table === 'std_domain' && r.f !== row.flaggedCnt)
      problems.push(`review RMS ${r.f} ≠ STDV1 ${row.flaggedCnt}`);
    row.rmsCnt = r.n;
    row.check += ' / STDV1 = RMS(복사 로그·origin 역조인)';
    if (problems.length > 0) row.result = 'MISMATCH';
    row.note = [row.note, problems.length ? `RMS: ${problems.join(', ')}` : 'RMS 일치']
      .filter(Boolean)
      .join(' / ');
  }

  // 테이블·컬럼(legacy → RMS 업무구분 RP)
  const l = await one<{ t: number; c: number }>(
    q,
    sql`select (select count(*) from legacy.tb_table_schema)::int t, (select count(*) from legacy.tb_column_schema)::int c`,
  );
  const tt = await one<{ n: number; f: number; nonrp: number }>(
    q,
    sql`select count(*)::int n, count(*) filter (where t.review_yn)::int f,
               count(*) filter (where b.biz_cd <> 'RP' or t.status <> 'FINAL')::int nonrp
          from prj_table t join prj_biz_area b on b.biz_area_id = t.biz_area_id where t.project_id = ${rms}`,
  );
  const tmap = await setDiff(
    q,
    sql`select trim(table_id) k from legacy.tb_table_schema`,
    sql`select legacy_table_id k from prj_table where project_id = ${rms}`,
  );
  const perTable = await one<{ bad: number; sample: string | null }>(
    q,
    sql`with l as (select table_id, count(*) n from legacy.tb_column_schema group by table_id),
             r as (select t.legacy_table_id table_id, count(c.column_id) n from prj_table t
                     left join prj_column c on c.table_id = t.table_id
                    where t.project_id = ${rms} group by t.legacy_table_id)
        select count(*)::int bad, string_agg(coalesce(l.table_id, r.table_id), ', ') sample
          from l full join r on r.table_id = l.table_id where coalesce(l.n, -1) <> coalesce(r.n, -1)`,
  );
  const cc = await one<{
    n: number;
    foreign_ref: number;
    dom: number;
    dflt: number;
    code: number;
    typ: number;
  }>(
    q,
    sql`select count(*)::int n,
               count(*) filter (where (c.domain_id is not null and d.project_id <> ${rms})
                                   or (c.code_cls_id is not null and k.project_id <> ${rms})
                                   or (c.default_col_id is not null and f.project_id <> ${rms}))::int foreign_ref,
               count(c.domain_id)::int dom, count(c.default_col_id)::int dflt, count(c.code_cls_id)::int code,
               count(*) filter (where c.data_type is null)::int typ
          from prj_column c
          left join std_domain d on d.domain_id = c.domain_id
          left join std_code_cls k on k.code_cls_id = c.code_cls_id
          left join std_default_col f on f.default_col_id = c.default_col_id
         where c.project_id = ${rms}`,
  );
  const tOk = l.t === tt.n && tmap.onlyLegacy === 0 && tmap.onlyTarget === 0 && tt.nonrp === 0;
  rows.push({
    item: '테이블',
    legacyCnt: l.t,
    excludedCnt: 0,
    stdv1Cnt: 0,
    rmsCnt: tt.n,
    flaggedCnt: tt.f,
    check: 'legacy_table_id 집합 동일, 업무구분 RP·FINAL',
    result: tOk ? 'OK' : 'MISMATCH',
    note:
      `review ${tt.f}(PK 없음·타입 확인)` +
      (tmap.sample ? `, 차이: ${tmap.sample}` : '') +
      (tt.nonrp ? `, RP·FINAL 아님 ${tt.nonrp}` : ''),
  });
  const cOk = l.c === cc.n && perTable.bad === 0 && cc.foreign_ref === 0;
  rows.push({
    item: '컬럼',
    legacyCnt: l.c,
    excludedCnt: 0,
    stdv1Cnt: 0,
    rmsCnt: cc.n,
    flaggedCnt: cc.typ,
    check: '건수·테이블별 컬럼 수 동일, 참조(도메인·코드구분·기본컬럼)가 모두 RMS 행',
    result: cOk ? 'OK' : 'MISMATCH',
    note:
      `도메인 연결 ${cc.dom} · 기본컬럼 연결 ${cc.dflt} · 코드구분 ${cc.code} · 타입 NULL ${cc.typ}` +
      (perTable.bad ? ` · 컬럼 수 불일치 테이블 ${perTable.bad}: ${perTable.sample}` : '') +
      (cc.foreign_ref ? ` · 다른 프로젝트 참조 ${cc.foreign_ref}` : ''),
  });
}
