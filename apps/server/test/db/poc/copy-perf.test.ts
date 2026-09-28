import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/db/migrate.js';
import { createDatabase } from '../setup/databases.js';

// T1.8 복사 성능 스파이크(§4.4): 약 7,540행을 INSERT … SELECT로 새 project_id에 복사, sql 템플릿 바인딩만
// PoC 전용. 정식 ProjectCopyService(C1~C7)는 단계 5(T5.2).

const M = 'MIGRATION';

/** 합성 원본(템플릿): 업무구분 6·분류 84·용어 1,705·도메인 4,587·코드구분 157·코드 991·세트 1·기본컬럼 9. */
async function seedSource(pool: pg.Pool): Promise<number> {
  const p = await pool.query<{ project_id: number }>(
    `insert into tf_project(project_key,project_nm,kind,created_by,updated_by)
     values ('STDV1','TermFlow 기본 표준 v1','TEMPLATE',$1,$1) returning project_id`,
    [M],
  );
  const src = p.rows[0]!.project_id;
  const q = (text: string) => pool.query(text, [src, M]);
  await q(`insert into prj_biz_area(project_id,biz_cd,biz_nm,table_prefix,sort_no,created_by,updated_by)
           select $1, cd, nm, cd||'_', ord, $2, $2
             from unnest(array['AC','BD','CT','GW','PS','RP'], array['회계','예산','계약','전자결재','인사','연구과제'])
                  with ordinality as t(cd, nm, ord)`);
  await q(`insert into std_domain_cls(project_id,suffix,cls_nm,col_type,col_length,created_by,updated_by)
           select $1, 'SFX'||lpad(g::text,2,'0'), '분류'||g, 'VARCHAR', 20, $2, $2 from generate_series(1,84) g`);
  await q(`insert into std_term(project_id,term_kor,term_physical,description,created_by,updated_by)
           select $1, '용어'||g, 'T'||g, '설명 '||g, $2, $2 from generate_series(1,1705) g`);
  await q(`insert into std_domain(project_id,nm1,nm2,logical_nm,physical_nm,suffix,domain_cls_id,col_type,col_length,created_by,updated_by)
           select $1, '용어'||(g%1705+1), '분류'||(g%84+1), '도메인'||g, 'T'||(g%1705+1)||'_SFX'||lpad((g%84+1)::text,2,'0'),
                  c.suffix, c.domain_cls_id, 'VARCHAR', 20, $2, $2
             from generate_series(1,4587) g
             join std_domain_cls c on c.project_id=$1 and c.suffix='SFX'||lpad((g%84+1)::text,2,'0')`);
  await q(`insert into std_code_cls(project_id,biz_area_id,code_cls,code_cls_nm,created_by,updated_by)
           select $1, b.biz_area_id, b.biz_cd||lpad(g::text,3,'0'), '코드구분'||g, $2, $2
             from generate_series(1,157) g join prj_biz_area b on b.project_id=$1 and b.sort_no=(g%6)+1`);
  // 49구분×7 + 108구분×6 = 991
  await q(`insert into std_code(project_id,code_cls_id,code,code_nm,sort_order,created_by,updated_by)
           select $1, c.code_cls_id, lpad(n::text,2,'0'), '코드'||n, n, $2, $2
             from (select code_cls_id, row_number() over (order by code_cls_id) rn
                     from std_code_cls where project_id=$1) c
             cross join lateral generate_series(1, case when c.rn <= 49 then 7 else 6 end) n`);
  const s = await pool.query<{ set_id: number }>(
    `insert into std_default_col_set(project_id,set_nm,is_default,created_by,updated_by)
     values ($1,'기본',true,$2,$2) returning set_id`,
    [src, M],
  );
  await pool.query(
    `insert into std_default_col(project_id,set_id,col_seq,logical_nm,physical_nm,data_type,data_length,created_by,updated_by)
     select $1, $2, g, '기본컬럼'||g, 'DFLT_COL_'||g, 'VARCHAR', 20, $3, $3 from generate_series(1,9) g`,
    [src, s.rows[0]!.set_id, M],
  );
  await pool.query('update tf_project set default_col_set_id=$1 where project_id=$2', [
    s.rows[0]!.set_id,
    src,
  ]);
  return src;
}

interface CopyInput {
  src: number;
  key: string;
  bizCds: string[];
  approvedOnly: boolean;
  actor: string;
  ip: string | null;
  creatorUserId: number;
  failAfterStep?: number;
}

type StepCounts = Record<string, number>;

/** §4.4 순서 1~8 + 10(기록). C3 재검증(9)은 원본이 모두 같으므로 생략(§4.4 규칙). */
async function copyProject(
  db: NodePgDatabase,
  i: CopyInput,
): Promise<{
  projectId: number;
  counts: StepCounts;
  stepMs: Record<number, number>;
  elapsedMs: number;
}> {
  const t0 = performance.now();
  const counts: StepCounts = {};
  const stepMs: Record<number, number> = {};
  const a = i.actor;
  const ip = i.ip;
  const bizCds = sql.param(i.bizCds); // 배열을 파라미터 1개로(sql 템플릿에 JS 배열을 그대로 넣으면 ($1,$2,…) 목록으로 펼쳐진다)
  const projectId = await db.transaction(
    async (tx) => {
      let tStep = performance.now();
      const fail = (step: number) => {
        const now = performance.now();
        stepMs[step] = Math.round(now - tStep);
        tStep = now;
        if (i.failAfterStep === step) throw new Error(`실패 주입: step ${step} 이후`);
      };
      // 1 프로젝트 행 + 생성자 ADMIN
      const p = await tx.execute<{ project_id: number }>(sql`
        INSERT INTO tf_project(project_key, project_nm, kind, default_dialect, include_default_cols,
                               copied_from_project_id, created_by, created_ip, updated_by, updated_ip)
        SELECT ${i.key}, ${i.key + ' 프로젝트'}, 'PROJECT', s.default_dialect, s.include_default_cols,
               s.project_id, ${a}, ${ip}, ${a}, ${ip}
          FROM tf_project s WHERE s.project_id = ${i.src}
        RETURNING project_id`);
      const n = p.rows[0]!.project_id;
      await tx.execute(sql`
        INSERT INTO tf_project_member(project_id, user_id, member_role, created_by, created_ip, updated_by, updated_ip)
        VALUES (${n}, ${i.creatorUserId}, 'ADMIN', ${a}, ${ip}, ${a}, ${ip})`);
      fail(1);
      // 2 업무구분
      counts['BIZ_AREA'] = (
        await tx.execute(sql`
        INSERT INTO prj_biz_area(project_id, biz_cd, biz_nm, table_prefix, sort_no, use_yn, description,
                                 origin_project_id, origin_id, created_by, created_ip, updated_by, updated_ip)
        SELECT ${n}, b.biz_cd, b.biz_nm, b.table_prefix, b.sort_no, b.use_yn, b.description,
               b.project_id, b.biz_area_id, ${a}, ${ip}, ${a}, ${ip}
          FROM prj_biz_area b WHERE b.project_id = ${i.src} AND b.biz_cd = ANY(${bizCds}::text[])`)
      ).rowCount!;
      fail(2);
      // 3 도메인분류
      counts['DOMAIN_CLS'] = (
        await tx.execute(sql`
        INSERT INTO std_domain_cls(project_id, suffix, cls_nm, col_type, col_length, col_scale, description, review_yn,
                                   origin_project_id, origin_id, created_by, created_ip, updated_by, updated_ip)
        SELECT ${n}, c.suffix, c.cls_nm, c.col_type, c.col_length, c.col_scale, c.description, c.review_yn,
               c.project_id, c.domain_cls_id, ${a}, ${ip}, ${a}, ${ip}
          FROM std_domain_cls c WHERE c.project_id = ${i.src}`)
      ).rowCount!;
      fail(3);
      // 4 용어
      counts['TERM'] = (
        await tx.execute(sql`
        INSERT INTO std_term(project_id, term_kor, term_physical, description, synonym_ref, status, review_yn, review_note,
                             reviewed_by, reviewed_at, origin_project_id, origin_id, created_by, created_ip, updated_by, updated_ip)
        SELECT ${n}, t.term_kor, t.term_physical, t.description, t.synonym_ref, t.status, t.review_yn, t.review_note,
               t.reviewed_by, t.reviewed_at, t.project_id, t.term_id, ${a}, ${ip}, ${a}, ${ip}
          FROM std_term t WHERE t.project_id = ${i.src} AND (NOT ${i.approvedOnly} OR t.status = 'APPROVED')`)
      ).rowCount!;
      fail(4);
      // 5 도메인(분류는 자연키 suffix로 새 프로젝트 분류에 연결)
      counts['DOMAIN'] = (
        await tx.execute(sql`
        INSERT INTO std_domain(project_id, nm1, nm2, nm3, nm4, nm5, nm6, nm7, logical_nm, physical_nm, descr, suffix,
                               domain_cls_id, col_type, col_length, col_scale, type_source, review_yn, review_note,
                               origin_project_id, origin_id, created_by, created_ip, updated_by, updated_ip)
        SELECT ${n}, d.nm1, d.nm2, d.nm3, d.nm4, d.nm5, d.nm6, d.nm7, d.logical_nm, d.physical_nm, d.descr, d.suffix,
               nc.domain_cls_id, d.col_type, d.col_length, d.col_scale, d.type_source, d.review_yn, d.review_note,
               d.project_id, d.domain_id, ${a}, ${ip}, ${a}, ${ip}
          FROM std_domain d
          LEFT JOIN std_domain_cls nc ON nc.project_id = ${n} AND nc.suffix = d.suffix
         WHERE d.project_id = ${i.src}`)
      ).rowCount!;
      fail(5);
      // 6 코드구분(업무구분은 자연키 biz_cd)
      counts['CODE_CLS'] = (
        await tx.execute(sql`
        INSERT INTO std_code_cls(project_id, biz_area_id, code_cls, code_cls_nm, description,
                                 origin_project_id, origin_id, created_by, created_ip, updated_by, updated_ip)
        SELECT ${n}, nb.biz_area_id, c.code_cls, c.code_cls_nm, c.description,
               c.project_id, c.code_cls_id, ${a}, ${ip}, ${a}, ${ip}
          FROM std_code_cls c
          JOIN prj_biz_area sb ON sb.biz_area_id = c.biz_area_id
          JOIN prj_biz_area nb ON nb.project_id = ${n} AND nb.biz_cd = sb.biz_cd
         WHERE c.project_id = ${i.src} AND sb.biz_cd = ANY(${bizCds}::text[])`)
      ).rowCount!;
      fail(6);
      // 7 코드(같은 원본 → origin 컬럼으로 조인)
      counts['CODE'] = (
        await tx.execute(sql`
        INSERT INTO std_code(project_id, code_cls_id, code, code_nm, sort_order, is_active,
                             origin_project_id, origin_id, created_by, created_ip, updated_by, updated_ip)
        SELECT ${n}, nc.code_cls_id, x.code, x.code_nm, x.sort_order, x.is_active,
               x.project_id, x.code_id, ${a}, ${ip}, ${a}, ${ip}
          FROM std_code x
          JOIN std_code_cls nc ON nc.project_id = ${n} AND nc.origin_project_id = ${i.src} AND nc.origin_id = x.code_cls_id
         WHERE x.project_id = ${i.src}`)
      ).rowCount!;
      fail(7);
      // 8 기본컬럼 세트·구성 + 프로젝트 기본 세트 지정
      counts['DEFAULT_COL_SET'] = (
        await tx.execute(sql`
        INSERT INTO std_default_col_set(project_id, set_nm, description, is_default,
                                        origin_project_id, origin_id, created_by, created_ip, updated_by, updated_ip)
        SELECT ${n}, s.set_nm, s.description, s.is_default, s.project_id, s.set_id, ${a}, ${ip}, ${a}, ${ip}
          FROM std_default_col_set s WHERE s.project_id = ${i.src}`)
      ).rowCount!;
      counts['DEFAULT_COL'] = (
        await tx.execute(sql`
        INSERT INTO std_default_col(project_id, set_id, col_seq, logical_nm, physical_nm, is_pk, data_type, data_length,
                                    data_scale, is_nullable, default_val, col_comment, origin_project_id, origin_id,
                                    created_by, created_ip, updated_by, updated_ip)
        SELECT ${n}, ns.set_id, c.col_seq, c.logical_nm, c.physical_nm, c.is_pk, c.data_type, c.data_length,
               c.data_scale, c.is_nullable, c.default_val, c.col_comment, c.project_id, c.default_col_id,
               ${a}, ${ip}, ${a}, ${ip}
          FROM std_default_col c
          JOIN std_default_col_set ns ON ns.project_id = ${n} AND ns.origin_project_id = ${i.src} AND ns.origin_id = c.set_id
         WHERE c.project_id = ${i.src}`)
      ).rowCount!;
      await tx.execute(sql`
        UPDATE tf_project t SET default_col_set_id = ns.set_id
          FROM tf_project s
          JOIN std_default_col_set ns ON ns.project_id = ${n} AND ns.origin_id = s.default_col_set_id
         WHERE t.project_id = ${n} AND s.project_id = ${i.src}`);
      fail(8);
      // 10 기록(항목별 1행)
      const batchId = crypto.randomUUID();
      const ms = Math.round(performance.now() - t0);
      for (const [item, cnt] of Object.entries(counts)) {
        await tx.execute(sql`
          INSERT INTO project_copy_log(project_id, batch_id, operation, item, source_kind, source_project_id,
                                       source_cnt, copied_cnt, elapsed_ms, copied_by)
          VALUES (${n}, ${batchId}, 'CREATE', ${item}, 'TEMPLATE', ${i.src}, ${cnt}, ${cnt}, ${ms}, ${a})`);
      }
      return n;
    },
    { isolationLevel: 'repeatable read' },
  );
  return { projectId, counts, stepMs, elapsedMs: Math.round(performance.now() - t0) };
}

describe('poc/copy-perf (T1.8)', () => {
  let pool: pg.Pool;
  let db: NodePgDatabase;
  let src: number;
  let userId: number;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createDatabase('poc_copy') });
    await runMigrations(pool);
    src = await seedSource(pool);
    const u = await pool.query<{ user_id: number }>(
      `insert into tf_user(login_id,user_nm,password_hash,created_by,updated_by)
       values ('hong','홍길동','x','SYSTEM','SYSTEM') returning user_id`,
    );
    userId = u.rows[0]!.user_id;
    await pool.query('analyze');
    db = drizzle(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  const input = (key: string, extra: Partial<CopyInput> = {}): CopyInput => ({
    src,
    key,
    bizCds: ['AC', 'BD', 'CT', 'GW', 'PS', 'RP'],
    approvedOnly: false,
    actor: 'hong',
    ip: '127.0.0.1',
    creatorUserId: userId,
    ...extra,
  });

  it('약 7,540행을 한 트랜잭션에서 5초 이내(목표 1초 미만) 복사', async () => {
    const runs: number[] = [];
    let last: Awaited<ReturnType<typeof copyProject>> | undefined;
    for (const key of ['PRJA', 'PRJB', 'PRJC']) {
      last = await copyProject(db, input(key));
      runs.push(last.elapsedMs);
      console.log(
        `[poc/copy] ${key} 단계별 ms ${JSON.stringify(last.stepMs)} 합계 ${last.elapsedMs}ms`,
      );
    }
    const total = Object.values(last!.counts).reduce((x, y) => x + y, 0);
    console.log(
      `[poc/copy] 복사 ${total}행 (${JSON.stringify(last!.counts)}) 소요 ${runs.join('ms, ')}ms`,
    );
    expect(last!.counts).toEqual({
      BIZ_AREA: 6,
      DOMAIN_CLS: 84,
      TERM: 1705,
      DOMAIN: 4587,
      CODE_CLS: 157,
      CODE: 991,
      DEFAULT_COL_SET: 1,
      DEFAULT_COL: 9,
    });
    expect(total).toBe(7540);
    expect(Math.max(...runs)).toBeLessThan(5000);

    // 교차 참조가 새 프로젝트 안에서만 닫혔는지
    const { rows } = await pool.query<{ bad_dom: string; bad_code: string; colset: number | null }>(
      `select (select count(*) from std_domain d where d.project_id=$1 and d.domain_cls_id is null) bad_dom,
              (select count(*) from std_code x join std_code_cls c on c.code_cls_id=x.code_cls_id
                where x.project_id=$1 and c.project_id<>$1) bad_code,
              (select default_col_set_id from tf_project where project_id=$1) colset`,
      [last!.projectId],
    );
    expect(rows[0]).toMatchObject({ bad_dom: '0', bad_code: '0' });
    expect(rows[0]?.colset).not.toBeNull();
  });

  it.skipIf(!process.env['POC_EXPLAIN'])('explain', async () => {
    const c = await pool.connect();
    await c.query('begin');
    const np = await c.query<{ project_id: number }>(
      "insert into tf_project(project_key,project_nm,created_by,updated_by) values ('EXPL','x','a','a') returning project_id",
    );
    const n = np.rows[0]!.project_id;
    await c.query(
      `insert into std_domain_cls(project_id,suffix,cls_nm,col_type,col_length,created_by,updated_by)
       select $1,suffix,cls_nm,col_type,col_length,'a','a' from std_domain_cls where project_id=$2`,
      [n, src],
    );
    const r = await c.query(
      `explain (analyze, buffers, timing) insert into std_domain(project_id,nm1,logical_nm,physical_nm,suffix,domain_cls_id,col_type,col_length,origin_project_id,origin_id,created_by,updated_by)
       select $1,d.nm1,d.logical_nm,d.physical_nm,d.suffix,nc.domain_cls_id,d.col_type,d.col_length,d.project_id,d.domain_id,'a','a'
         from std_domain d left join std_domain_cls nc on nc.project_id=$1 and nc.suffix=d.suffix where d.project_id=$2`,
      [n, src],
    );
    console.log(
      r.rows.map((x: Record<string, string>) => x['QUERY PLAN']).join(String.fromCharCode(10)),
    );
    await c.query('rollback');
    c.release();
  });

  it('업무구분 일부 선택 시 해당 코드구분·코드만 복사, 빈 배열도 안전', async () => {
    const r = await copyProject(db, input('PRJD', { bizCds: ['RP'] }));
    expect(r.counts['BIZ_AREA']).toBe(1);
    expect(r.counts['CODE_CLS']).toBeGreaterThan(0);
    expect(r.counts['CODE_CLS']).toBeLessThan(157);
    const e = await copyProject(db, input('PRJE', { bizCds: [] }));
    expect(e.counts['BIZ_AREA']).toBe(0);
    expect(e.counts['CODE']).toBe(0);
  });

  it('실패 주입 시 전체 롤백(프로젝트·멤버·사본 0행)', async () => {
    const before = await pool.query<{ n: string }>('select count(*) n from std_term');
    await expect(copyProject(db, input('PRJF', { failAfterStep: 7 }))).rejects.toThrow(/실패 주입/);
    const p = await pool.query("select 1 from tf_project where project_key='PRJF'");
    expect(p.rows).toHaveLength(0);
    const after = await pool.query<{ n: string }>('select count(*) n from std_term');
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });
});
