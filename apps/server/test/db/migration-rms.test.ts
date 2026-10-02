import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/db/client.js';
import type { RunSummary } from '../../src/migration/runner.js';
import { createMigratedDatabase } from './setup/databases.js';
import { insertUsers, PHASE1, PHASE2, runSteps, tempReportRoot } from './setup/stdv1.js';

// 승계 2차(3b): COPY_TO_RMS..RECONCILE(T5.9~T5.11, 게이트 5). `pnpm test:db -- migration`
const stepStatus = (s: RunSummary) => Object.fromEntries(s.steps.map((x) => [x.step, x.status]));
const csvRows = (s: RunSummary, file: string) =>
  readFileSync(path.join(s.reportDir, `${file}.csv`), 'utf8')
    .replace(String.fromCharCode(0xfeff), '')
    .trimEnd()
    .split('\r\n')
    .slice(1)
    .filter((l) => l !== '');

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

describe('승계 2차(RETAILV1 → RMS 복사 · 33 테이블 · 전체 대사)', () => {
  let pool: pg.Pool;
  let db: Db;
  let url: string;
  let second: RunSummary;
  const rep = tempReportRoot('tf-mig2-');
  beforeAll(async () => {
    url = await createMigratedDatabase('t_mig_rms');
    pool = new pg.Pool({ connectionString: url, max: 4 });
    db = createDb(pool);
    const first = await runSteps({ pool, db, url }, rep.dir, 'p1', PHASE1);
    expect(first.ok).toBe(true);
  });
  afterAll(async () => {
    await pool.end();
    rep.cleanup();
  });

  it('프로젝트 관리자(--rms-admin) 사용자가 없으면 명확한 오류로 중단, RMS는 남지 않는다', async () => {
    const r = await runSteps({ pool, db, url }, rep.dir, 'p2-noadmin', ['COPY_TO_RMS'], {
      rmsAdmin: 'ghost',
    });
    expect(r.ok).toBe(false);
    expect(r.steps[0]).toMatchObject({ step: 'COPY_TO_RMS', status: 'FAILED' });
    expect(r.steps[0]!.message).toContain("'ghost' 사용자가 없습니다");
    const p = await pool.query("select count(*)::int n from tf_project where project_key = 'RMS'");
    expect(p.rows[0]).toEqual({ n: 0 });
  });

  it('COPY_TO_RMS..RECONCILE: 전 step SUCCESS(종료 코드 0 상당)', async () => {
    await insertUsers(pool);
    second = await runSteps({ pool, db, url }, rep.dir, 'p2', PHASE2);
    for (const s of second.steps)
      console.log(`[test:db migration-rms] ${s.step} ${s.seconds}s — ${s.message}`);
    expect(stepStatus(second)).toEqual({
      COPY_TO_RMS: 'SUCCESS',
      TABLE: 'SUCCESS',
      RECONCILE: 'SUCCESS',
    });
  });

  it('COPY_TO_RMS(T5.9): RMS 표준 건수 = RETAILV1, project_copy_log 8행(합 5초 이내), 관리자 = admin', async () => {
    const { rows } = await pool.query(`
      select (select count(*) from prj_biz_area b where b.project_id = p.project_id)::int biz,
             (select count(*) from std_term t where t.project_id = p.project_id)::int term,
             (select count(*) from std_domain_cls t where t.project_id = p.project_id)::int cls,
             (select count(*) from std_domain t where t.project_id = p.project_id)::int dom,
             (select count(*) from std_domain t where t.project_id = p.project_id and t.review_yn)::int dom_review,
             (select count(*) from std_code_cls t where t.project_id = p.project_id)::int code_cls,
             (select count(*) from std_code t where t.project_id = p.project_id)::int code,
             (select count(*) from std_default_col t where t.project_id = p.project_id)::int dcol,
             p.default_col_set_id is not null has_set
        from tf_project p where p.project_key in ('RETAILV1', 'RMS') order by p.project_key`);
    const [rms, stdv1] = rows;
    expect(rms).toEqual(stdv1);
    expect(rms).toMatchObject({
      biz: 6,
      term: 1705,
      cls: 84,
      dom: 4587,
      dom_review: 293,
      code_cls: 159,
      code: 991,
      dcol: 9,
      has_set: true,
    });
    const log = await pool.query(`select item, source_kind, source_cnt, copied_cnt, elapsed_ms
        from project_copy_log l join tf_project p on p.project_id = l.project_id
       where p.project_key = 'RMS' order by copy_id`);
    expect(log.rows).toHaveLength(8);
    expect(
      log.rows.every((r) => r.source_cnt === r.copied_cnt && r.source_kind === 'TEMPLATE'),
    ).toBe(true);
    const sum = log.rows.reduce((s, r) => s + Number(r.elapsed_ms), 0);
    console.log(
      `[test:db migration-rms] RMS 복사 elapsed_ms 합 ${sum}ms — ${log.rows.map((r) => `${r.item} ${r.elapsed_ms}`).join(' · ')}`,
    );
    // C6 5초 판정은 test:db copy(단독 측정)가 한다. 여기서는 병렬 실행(컨테이너 공유) 중 상한만 확인
    expect(sum).toBeLessThan(15000);
    const m = await pool.query(`select u.login_id, m.member_role from tf_project_member m
        join tf_user u using (user_id) join tf_project p using (project_id) where p.project_key = 'RMS'`);
    expect(m.rows).toEqual([{ login_id: 'admin', member_role: 'ADMIN' }]);
    const origin =
      await pool.query(`select count(*)::int n from std_domain d join tf_project p on p.project_id = d.project_id
       where p.project_key = 'RMS' and d.origin_project_id = (select project_id from tf_project where project_key = 'RETAILV1')`);
    expect(origin.rows[0]).toEqual({ n: 4587 });
  });

  it('TABLE(T5.10): 33 테이블(RP·FINAL)·649 컬럼, 참조는 모두 RMS 행, 이력 MIGRATE 33, 리포트', async () => {
    const t = await pool.query(`
      select count(*)::int n, count(*) filter (where t.status = 'FINAL')::int fin, count(*) filter (where b.biz_cd = 'RP')::int rp,
             count(*) filter (where t.review_yn and t.review_note like '%PK 없음%')::int no_pk,
             count(*) filter (where t.legacy_table_id like 'TBL%')::int legacy, min(t.created_by) created_by
        from prj_table t join prj_biz_area b on b.biz_area_id = t.biz_area_id
        join tf_project p on p.project_id = t.project_id where p.project_key = 'RMS'`);
    expect(t.rows[0]).toEqual({
      n: 33,
      fin: 33,
      rp: 33,
      no_pk: 3,
      legacy: 33,
      created_by: 'MIGRATION',
    });
    const c = await pool.query(`
      select count(*)::int n, count(c.domain_id)::int dom, count(c.default_col_id)::int dflt, count(c.code_cls_id)::int code,
             count(*) filter (where c.match_type = 'CODE')::int m_code, count(*) filter (where c.match_type = 'DEFAULT')::int m_dflt,
             count(*) filter (where c.data_type is null)::int typ_null,
             count(*) filter (where c.is_pk and c.is_nullable)::int pk_null,
             count(*) filter (where c.col_comment is null or c.col_comment = '')::int no_comment,
             count(*) filter (where d.project_id <> c.project_id or k.project_id <> c.project_id
                                 or f.project_id <> c.project_id)::int foreign_ref
        from prj_column c join tf_project p on p.project_id = c.project_id
        left join std_domain d on d.domain_id = c.domain_id left join std_code_cls k on k.code_cls_id = c.code_cls_id
        left join std_default_col f on f.default_col_id = c.default_col_id
       where p.project_key = 'RMS'`);
    // 도메인 연결(EXACT 일치) 264 = dump 기준(설계 261은 init 기준, CR-04 §2) · 기본컬럼 297 · 코드구분(R7-b) 5
    expect(c.rows[0]).toEqual({
      n: 649,
      dom: 264,
      dflt: 297,
      code: 5,
      m_code: 5,
      m_dflt: 297,
      typ_null: 0,
      pk_null: 0,
      no_comment: 0,
      foreign_ref: 0,
    });
    const phys = await pool.query(
      "select physical_nm from prj_column where logical_nm in ('채택결과코드', '초안여부') order by 1",
    );
    expect(phys.rows.map((r) => r.physical_nm)).toEqual(['ADPT_RSLT_CD', 'DRFT_YN']);
    const json = await pool.query(
      "select count(*)::int n from prj_column where physical_nm in ('OLD_DATA', 'NEW_DATA') and data_type = 'JSONB'",
    );
    expect(json.rows[0]).toEqual({ n: 4 });
    const h =
      await pool.query(`select count(*)::int n, min(action) a, min(snapshot->'table'->>'bizCd') biz,
        min(jsonb_array_length(snapshot->'columns'))::int min_cols from prj_table_history`);
    expect(h.rows[0]).toEqual({ n: 33, a: 'MIGRATE', biz: 'RP', min_cols: 11 });
    expect(csvRows(second, 'r06_tables')).toHaveLength(33);
    expect(csvRows(second, 'r06_pk_nullable_fixed')).toHaveLength(1);
    expect(csvRows(second, 'r07b_column_code_cls')).toHaveLength(5);
    expect(csvRows(second, 'r09_physical_normalized')).toHaveLength(2);
    expect(csvRows(second, 'r17_no_pk')).toHaveLength(3);
    expect(csvRows(second, 'r11_dup_reserved')).toHaveLength(0);
    expect(csvRows(second, 'r10_column_type_review')).toHaveLength(2);
  });

  it('RECONCILE(T5.11): reconcile.csv 9항목 100% OK, RMS 열 채움(G7 dev 리허설)', () => {
    const rec = csvRows(second, 'reconcile').map(parseCsvLine);
    expect(rec.map((r) => [r[0], r[7]])).toEqual(
      [
        '업무구분',
        '도메인분류',
        '용어',
        '도메인',
        '코드구분',
        '코드',
        '기본컬럼',
        '테이블',
        '컬럼',
      ].map((i) => [i, 'OK']),
    );
    expect(Object.fromEntries(rec.map((r) => [r[0], Number(r[4])]))).toEqual({
      업무구분: 6,
      도메인분류: 84,
      용어: 1705,
      도메인: 4587,
      코드구분: 159,
      코드: 991,
      기본컬럼: 9,
      테이블: 33,
      컬럼: 649,
    });
  });

  it('재실행: COPY_TO_RMS·TABLE SKIPPED, RECONCILE SUCCESS', async () => {
    const again = await runSteps({ pool, db, url }, rep.dir, 'p2-again', PHASE2);
    expect(stepStatus(again)).toEqual({
      COPY_TO_RMS: 'SKIPPED',
      TABLE: 'SKIPPED',
      RECONCILE: 'SUCCESS',
    });
  });

  it('RECONCILE 불일치(RMS 컬럼 1건 삭제) → FAILED', async () => {
    await pool.query(`delete from prj_column where column_id = (select min(column_id) from prj_column c
        join tf_project p using (project_id) where p.project_key = 'RMS')`);
    const r = await runSteps({ pool, db, url }, rep.dir, 'p2-bad', ['RECONCILE']);
    expect(r.ok).toBe(false);
    expect(csvRows(r, 'reconcile').find((l) => l.startsWith('컬럼,'))).toContain('MISMATCH');
  });
});
