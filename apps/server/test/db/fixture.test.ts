import bcrypt from 'bcrypt';
import { describe, expect, it } from 'vitest';
import { FIXTURE_PASSWORD, loadFixture, truncateAll, useTestDb } from './setup/databases.js';

// T2.12 DoD: 픽스처 std_small.sql(§13.3) 적재 + TRUNCATE 후 재적재
const t = useTestDb('t_fixture', { fixture: 'std_small' });

async function counts(): Promise<Record<string, Record<string, number>>> {
  const { rows } = await t.pool.query<{ project_key: string; item: string; n: string }>(`
    select p.project_key, x.item, x.n from tf_project p cross join lateral (
      select 'bizArea' item, count(*) n from prj_biz_area where project_id = p.project_id union all
      select 'term', count(*) from std_term where project_id = p.project_id union all
      select 'domainCls', count(*) from std_domain_cls where project_id = p.project_id union all
      select 'domain', count(*) from std_domain where project_id = p.project_id union all
      select 'codeCls', count(*) from std_code_cls where project_id = p.project_id union all
      select 'code', count(*) from std_code where project_id = p.project_id union all
      select 'defaultCol', count(*) from std_default_col where project_id = p.project_id union all
      select 'table', count(*) from prj_table where project_id = p.project_id union all
      select 'member', count(*) from tf_project_member where project_id = p.project_id) x`);
  const r: Record<string, Record<string, number>> = {};
  for (const row of rows) (r[row.project_key] ??= {})[row.item] = Number(row.n);
  return r;
}

const STD = {
  bizArea: 2,
  term: 50,
  domainCls: 20,
  domain: 100,
  codeCls: 5,
  code: 30,
  defaultCol: 9,
};

describe('fixture std_small (T2.12)', () => {
  it('템플릿 1 + 프로젝트 2, 항목 건수·사용자 4명(역할 4종)', async () => {
    expect(await counts()).toEqual({
      STDS: { ...STD, table: 0, member: 0 },
      PRJA: { ...STD, table: 1, member: 3 },
      PRJB: { ...STD, table: 1, member: 1 },
    });
    const users = await t.pool.query<{ login_id: string; is_sys_admin: boolean; hash: string }>(
      'select login_id, is_sys_admin, password_hash hash from tf_user order by user_id',
    );
    expect(users.rows.map((u) => u.login_id)).toEqual(['sysadmin', 'pa', 'editor', 'viewer']);
    expect(users.rows.filter((u) => u.is_sys_admin).map((u) => u.login_id)).toEqual(['sysadmin']);
    expect(await bcrypt.compare(FIXTURE_PASSWORD, users.rows[0]!.hash)).toBe(true);
  });

  it('두 프로젝트는 같은 테이블명·서로 다른 표준, PRJA만 출처(origin)가 STDS', async () => {
    const { rows } = await t.pool.query<{
      project_key: string;
      phys: string;
      origin: string | null;
    }>(
      `select p.project_key, t.term_physical phys, o.project_key origin
         from std_term t join tf_project p using (project_id)
         left join tf_project o on o.project_id = t.origin_project_id
        where t.term_kor = '용어1' order by p.project_id`,
    );
    expect(rows).toEqual([
      { project_key: 'STDS', phys: 'SS_T1', origin: null },
      { project_key: 'PRJA', phys: 'PA_T1', origin: 'STDS' },
      { project_key: 'PRJB', phys: 'PB_T1', origin: null },
    ]);
    const tables = await t.pool.query<{ n: string }>(
      "select count(distinct project_id) n from prj_table where table_nm = 'RP_RSCH_PRJ_MST'",
    );
    expect(tables.rows[0]?.n).toBe('2');
  });

  it('TRUNCATE 후 재적재하면 같은 상태(IDENTITY 재시작)', async () => {
    const before = await counts();
    await truncateAll(t.pool);
    expect((await t.pool.query('select 1 from tf_user')).rowCount).toBe(0);
    await loadFixture(t.pool, 'std_small');
    expect(await counts()).toEqual(before);
    const u = await t.pool.query<{ user_id: number }>(
      "select user_id from tf_user where login_id = 'sysadmin'",
    );
    expect(u.rows[0]?.user_id).toBe(1);
  });
});
