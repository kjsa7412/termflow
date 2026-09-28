import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { audit } from '../../src/common/audit/audit.js';
import { findPgError } from '../../src/common/problem/problem-detail.filter.js';
import { insertAudited } from '../../src/db/audit.js';
import { prjColumn } from '../../src/db/schema.js';
import { useTestDb } from './setup/databases.js';

// T2.13 스키마 제약 통합 테스트(§3.2, §3.6, CR-01-3의 DB 부분). 테스트마다 std_small 재적재.
const t = useTestDb('t_schema', { truncateEach: true, fixture: 'std_small' });

const one = async <T extends pg.QueryResultRow>(text: string, values: unknown[] = []) =>
  (await t.pool.query<T>(text, values)).rows[0]!;
const id = async (text: string, values: unknown[] = []) =>
  Number(Object.values(await one(text, values))[0]);
const pid = (key: string) => id('select project_id from tf_project where project_key=$1', [key]);

/** 실패한 질의의 pg 오류 코드·제약명. */
async function pgError(p: Promise<unknown>): Promise<{ code: string; constraint?: string }> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  const found = findPgError(e);
  if (!found) throw new Error(`pg 오류가 아님: ${String(e)}`);
  return found;
}

describe('교차 프로젝트 참조 거부 — 복합 FK (CR-01-3)', () => {
  it('prj_column → 다른 프로젝트의 도메인·코드구분·기본컬럼·테이블', async () => {
    const a = await pid('PRJA');
    const b = await pid('PRJB');
    const tableA = await id('select table_id from prj_table where project_id=$1', [a]);
    const domB = await id('select min(domain_id) from std_domain where project_id=$1', [b]);
    const clsB = await id('select min(code_cls_id) from std_code_cls where project_id=$1', [b]);
    const dcB = await id('select min(default_col_id) from std_default_col where project_id=$1', [
      b,
    ]);
    const ins = (col: string, v: number) =>
      t.pool.query(
        `insert into prj_column(project_id, table_id, col_seq, logical_nm, physical_nm, ${col}, created_by, updated_by)
         values ($1, $2, 9, '교차', 'CROSS_REF', $3, 't', 't')`,
        [a, tableA, v],
      );
    expect(await pgError(ins('domain_id', domB))).toEqual({
      code: '23503',
      constraint: 'fk_prj_column_domain',
    });
    expect((await pgError(ins('code_cls_id', clsB))).constraint).toBe('fk_prj_column_code_cls');
    expect((await pgError(ins('default_col_id', dcB))).constraint).toBe(
      'fk_prj_column_default_col',
    );
    // 같은 프로젝트 참조는 허용(Drizzle 감사 헬퍼 경로, DrizzleQueryError.cause 판정 포함)
    const domA = await id('select min(domain_id) from std_domain where project_id=$1', [a]);
    await insertAudited(
      t.db,
      prjColumn,
      {
        projectId: a,
        tableId: tableA,
        colSeq: 9,
        logicalNm: '정상',
        physicalNm: 'OK_REF',
        domainId: domA,
      },
      audit('editor'),
    );
    const viaDrizzle = await pgError(
      insertAudited(
        t.db,
        prjColumn,
        {
          projectId: a,
          tableId: tableA,
          colSeq: 10,
          logicalNm: '교차',
          physicalNm: 'X_REF',
          domainId: domB,
        },
        audit('editor'),
      ).execute(),
    );
    expect(viaDrizzle).toEqual({ code: '23503', constraint: 'fk_prj_column_domain' });
  });

  it('prj_column(project_id=A, table_id=B의 테이블) 거부', async () => {
    const a = await pid('PRJA');
    const tableB = await id('select table_id from prj_table where project_id=$1', [
      await pid('PRJB'),
    ]);
    const e = await pgError(
      t.pool.query(
        `insert into prj_column(project_id, table_id, col_seq, logical_nm, physical_nm, created_by, updated_by)
         values ($1, $2, 9, '교차', 'CROSS_TBL', 't', 't')`,
        [a, tableB],
      ),
    );
    expect(e).toEqual({ code: '23503', constraint: 'fk_prj_column_table' });
  });

  it('도메인→분류, 코드구분→업무구분, 코드→코드구분, 테이블→업무구분, 프로젝트→기본컬럼 세트', async () => {
    const a = await pid('PRJA');
    const b = await pid('PRJB');
    const clsB = await id('select min(domain_cls_id) from std_domain_cls where project_id=$1', [b]);
    const bizB = await id(
      "select biz_area_id from prj_biz_area where project_id=$1 and biz_cd='RP'",
      [b],
    );
    const codeClsB = await id('select min(code_cls_id) from std_code_cls where project_id=$1', [b]);
    const setB = await id('select set_id from std_default_col_set where project_id=$1', [b]);
    const cases: [string, unknown[], string][] = [
      [
        `insert into std_domain(project_id, nm1, logical_nm, domain_cls_id, created_by, updated_by) values ($1,'교차','교차도메인',$2,'t','t')`,
        [a, clsB],
        'fk_std_domain_cls',
      ],
      [
        `insert into std_code_cls(project_id, biz_area_id, code_cls, code_cls_nm, created_by, updated_by) values ($1,$2,'X01','교차','t','t')`,
        [a, bizB],
        'fk_std_code_cls_biz_area',
      ],
      [
        `insert into std_code(project_id, code_cls_id, code, code_nm, created_by, updated_by) values ($1,$2,'99','교차','t','t')`,
        [a, codeClsB],
        'fk_std_code_cls',
      ],
      [
        `insert into prj_table(project_id, biz_area_id, table_nm, table_logical_nm, created_by, updated_by) values ($1,$2,'X_TBL','교차','t','t')`,
        [a, bizB],
        'fk_prj_table_biz_area',
      ],
      [
        `update tf_project set default_col_set_id=$2 where project_id=$1`,
        [a, setB],
        'fk_tf_project_colset',
      ],
    ];
    for (const [q, v, constraint] of cases) {
      expect(await pgError(t.pool.query(q, v))).toEqual({ code: '23503', constraint });
    }
  });
});

describe('참조 삭제 — SET NULL(열)은 project_id를 보존', () => {
  it('도메인·코드구분·기본컬럼 삭제 → 컬럼의 해당 ID만 NULL', async () => {
    const a = await pid('PRJA');
    const before = await one<{ domain_id: number; code_cls_id: number; default_col_id: number }>(
      `select max(domain_id) domain_id, max(code_cls_id) code_cls_id, max(default_col_id) default_col_id
         from prj_column where project_id=$1`,
      [a],
    );
    await t.pool.query('delete from std_domain where domain_id=$1', [before.domain_id]);
    await t.pool.query('delete from std_code_cls where code_cls_id=$1', [before.code_cls_id]);
    await t.pool.query('delete from std_default_col where default_col_id=$1', [
      before.default_col_id,
    ]);
    const { rows } = await t.pool.query<{
      project_id: number;
      domain_id: number | null;
      code_cls_id: number | null;
      default_col_id: number | null;
    }>(
      'select project_id, domain_id, code_cls_id, default_col_id from prj_column where project_id=$1 order by col_seq',
      [a],
    );
    expect(rows).toHaveLength(3); // 컬럼은 남는다
    for (const r of rows) {
      expect(r).toMatchObject({
        project_id: a,
        domain_id: null,
        code_cls_id: null,
        default_col_id: null,
      });
    }
  });

  it('도메인분류 삭제 → 도메인 domain_cls_id NULL, 기본컬럼 세트 삭제 → 프로젝트 default_col_set_id NULL', async () => {
    const a = await pid('PRJA');
    const cls = await id('select min(domain_cls_id) from std_domain_cls where project_id=$1', [a]);
    const n = await id('select count(*) from std_domain where domain_cls_id=$1', [cls]);
    expect(n).toBeGreaterThan(0);
    await t.pool.query('delete from std_domain_cls where domain_cls_id=$1', [cls]);
    const orphan = await one<{ n: string; p: string }>(
      `select count(*) n, count(distinct project_id) p from std_domain
        where project_id=$1 and domain_cls_id is null`,
      [a],
    );
    expect(Number(orphan.n)).toBe(n);
    expect(orphan.p).toBe('1');

    await t.pool.query('delete from std_default_col_set where project_id=$1', [a]);
    const p = await one<{ default_col_set_id: number | null }>(
      'select default_col_set_id from tf_project where project_id=$1',
      [a],
    );
    expect(p.default_col_set_id).toBeNull();
    expect(await id('select count(*) from std_default_col where project_id=$1', [a])).toBe(0); // 세트 → 구성 CASCADE
  });
});

describe('프로젝트 삭제 — CASCADE와 출처 SET NULL', () => {
  const owned = [
    'prj_biz_area',
    'std_term',
    'std_domain_cls',
    'std_domain',
    'std_code_cls',
    'std_code',
    'std_default_col_set',
    'std_default_col',
    'prj_table',
    'prj_column',
    'tf_project_member',
  ];
  const ownedCount = async (projectId: number) => {
    let total = 0;
    for (const table of owned) {
      total += await id(`select count(*) from ${table} where project_id=$1`, [projectId]);
    }
    return total;
  };

  it('PRJA 삭제 → 소유 행 전부 제거(테이블→업무구분 NO ACTION도 통과), PRJB 영향 없음', async () => {
    const a = await pid('PRJA');
    const b = await pid('PRJB');
    const bBefore = await ownedCount(b);
    expect(await ownedCount(a)).toBeGreaterThan(0);
    await t.pool.query('delete from tf_project where project_id=$1', [a]);
    expect(await ownedCount(a)).toBe(0);
    expect(await ownedCount(b)).toBe(bBefore);
  });

  it('원본 STDS 삭제 → PRJA의 origin_project_id·copied_from_project_id NULL(origin_id는 유지)', async () => {
    const s = await pid('STDS');
    const a = await pid('PRJA');
    const before = await one<{ n: string; with_origin_id: string }>(
      'select count(*) n, count(origin_id) with_origin_id from std_term where project_id=$1 and origin_project_id=$2',
      [a, s],
    );
    expect(Number(before.n)).toBe(50);
    await t.pool.query('delete from tf_project where project_id=$1', [s]);
    const after = await one<{ with_origin: string; with_origin_id: string }>(
      'select count(origin_project_id) with_origin, count(origin_id) with_origin_id from std_term where project_id=$1',
      [a],
    );
    expect(after).toEqual({ with_origin: '0', with_origin_id: before.with_origin_id });
    for (const table of [
      'prj_biz_area',
      'std_domain_cls',
      'std_domain',
      'std_code_cls',
      'std_code',
      'std_default_col_set',
      'std_default_col',
    ]) {
      expect(
        await id(`select count(origin_project_id) from ${table} where project_id=$1`, [a]),
      ).toBe(0);
    }
    const p = await one<{ copied_from_project_id: number | null }>(
      'select copied_from_project_id from tf_project where project_id=$1',
      [a],
    );
    expect(p.copied_from_project_id).toBeNull();
  });

  it('업무구분 단독 삭제는 테이블이 있으면 거부(NO ACTION), 테이블 없는 업무구분은 코드구분·코드 CASCADE', async () => {
    const a = await pid('PRJA');
    const rp = await id(
      "select biz_area_id from prj_biz_area where project_id=$1 and biz_cd='RP'",
      [a],
    );
    expect(
      await pgError(t.pool.query('delete from prj_biz_area where biz_area_id=$1', [rp])),
    ).toEqual({
      code: '23503',
      constraint: 'fk_prj_table_biz_area',
    });
    const ps = await id(
      "select biz_area_id from prj_biz_area where project_id=$1 and biz_cd='PS'",
      [a],
    );
    const codes = await id(
      'select count(*) from std_code x join std_code_cls c using (code_cls_id) where c.biz_area_id=$1',
      [ps],
    );
    expect(codes).toBeGreaterThan(0);
    await t.pool.query('delete from prj_biz_area where biz_area_id=$1', [ps]);
    expect(await id('select count(*) from std_code_cls where biz_area_id=$1', [ps])).toBe(0);
  });
});

describe('DEFERRABLE 유니크 — 커밋 시점 검사', () => {
  it('트랜잭션 중간의 col_seq 중복은 허용, 커밋에서 uk_prj_column_seq 위반', async () => {
    const a = await pid('PRJA');
    const table = await id('select table_id from prj_table where project_id=$1', [a]);
    const client = await t.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('update prj_column set col_seq=1 where table_id=$1 and col_seq=2', [
        table,
      ]);
      const dup = await client.query<{ n: string }>(
        'select count(*) n from prj_column where table_id=$1 and col_seq=1',
        [table],
      );
      expect(dup.rows[0]?.n).toBe('2'); // 문장 시점에는 통과
      expect(await pgError(client.query('COMMIT'))).toEqual({
        code: '23505',
        constraint: 'uk_prj_column_seq',
      });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('같은 트랜잭션에서 물리명 교환·순서 교환은 커밋 성공', async () => {
    const a = await pid('PRJA');
    const table = await id('select table_id from prj_table where project_id=$1', [a]);
    const client = await t.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `update prj_column set col_seq = case col_seq when 1 then 2 when 2 then 1 else col_seq end,
                               physical_nm = case col_seq when 1 then 'PRGRS_STAT_CD' when 2 then 'RSCH_PRJ_ID' else physical_nm end
          where table_id=$1`,
        [table],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const { rows } = await t.pool.query<{ physical_nm: string }>(
      'select physical_nm from prj_column where table_id=$1 order by col_seq',
      [table],
    );
    expect(rows.map((r) => r.physical_nm)).toEqual(['RSCH_PRJ_ID', 'PRGRS_STAT_CD', 'WRK_RMK']);
  });
});
