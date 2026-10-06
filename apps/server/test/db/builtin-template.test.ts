import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { audit } from '../../src/common/audit/audit.js';
import {
  BUILTIN_STD,
  BUILTIN_STEP,
  prepareTemplates,
  RETAIL_TEMPLATE,
} from '../../src/project/builtin/builtin-template.js';
import { readTemplate, templateDir } from '../../src/project/builtin/template-files.js';
import type { CopyPlan, CopySource } from '../../src/project/copy/copy-plan.js';
import { executeCopy } from '../../src/project/copy/project-copy.service.js';
import { truncateAll, useTestDb } from './setup/databases.js';

// CR-16 C4: 기동 시 템플릿 준비 — 범용 STDV1 1회 적재(동봉 CSV = DB), 옛 승계 STDV1 → RETAILV1, 지운 뒤 재생성 안 함
const t = useTestDb('t_builtin_tpl');
const data = readTemplate(templateDir(BUILTIN_STD.key));
const logs: string[] = [];
const log = (m: string) => logs.push(m);

const one = async <T>(sqlText: string, params: unknown[] = []) =>
  (await t.pool.query(sqlText, params)).rows[0] as T;

async function countsOf(key: string): Promise<Record<string, number>> {
  return one(
    `select (select count(*)::int from prj_biz_area x where x.project_id = p.project_id) biz,
            (select count(*)::int from std_term x where x.project_id = p.project_id and x.status = 'APPROVED') term,
            (select count(*)::int from std_domain_cls x where x.project_id = p.project_id) cls,
            (select count(*)::int from std_domain x where x.project_id = p.project_id) domain,
            (select count(*)::int from std_domain x where x.project_id = p.project_id and (x.review_yn or x.domain_cls_id is null or x.physical_nm is null)) bad_domain,
            (select count(*)::int from std_code_cls x where x.project_id = p.project_id) code_cls,
            (select count(*)::int from std_code x where x.project_id = p.project_id) code,
            (select count(*)::int from std_default_col x where x.project_id = p.project_id) dcol
       from tf_project p where p.project_key = $1`,
    [key],
  );
}

beforeAll(async () => {
  await truncateAll(t.pool);
});
afterAll(() => {
  if (logs.length > 0) console.log(`[test:db builtin] ${logs.join(' | ')}`);
});

describe('범용 기본 표준 STDV1 적재(CR-16 C4)', () => {
  it('빈 DB: 한 번 적재 — 건수 = 동봉 CSV, 검토필요·분류 없음·물리명 없음 0, 기본 세트 지정, 적재 기록', async () => {
    const r = await prepareTemplates(t.db, log);
    expect(r).toMatchObject({ renamed: false, seeded: 'SEEDED' });
    expect(await countsOf(BUILTIN_STD.key)).toEqual({
      biz: data.bizAreas.length,
      term: data.terms.length,
      cls: data.domainClasses.length,
      domain: data.domains.length,
      bad_domain: 0,
      code_cls: new Set(data.codes.map((c) => `${c.bizCd}/${c.codeCls}`)).size,
      code: data.codes.length,
      dcol: data.defaultCols.length,
    });
    const p = await one<{ kind: string; created_by: string; set_nm: string; nm: string }>(
      `select p.kind, p.created_by, p.project_nm nm, s.set_nm
         from tf_project p join std_default_col_set s on s.set_id = p.default_col_set_id
        where p.project_key = $1`,
      [BUILTIN_STD.key],
    );
    expect(p).toEqual({
      kind: 'TEMPLATE',
      created_by: 'SYSTEM',
      nm: BUILTIN_STD.nm,
      set_nm: '표준 감사',
    });
    const ml = await one<{ n: number }>(
      "select count(*)::int n from migration_log where step = $1 and status = 'SUCCESS'",
      [BUILTIN_STEP],
    );
    expect(ml.n).toBe(1);
  });

  it('다시 불러도 그대로(ALREADY, 상태 로그 한 줄), 관리자가 지운 뒤에도 다시 만들지 않는다', async () => {
    const seen: string[] = [];
    expect((await prepareTemplates(t.db, (m) => seen.push(m))).seeded).toBe('ALREADY');
    await t.pool.query('delete from tf_project where project_key = $1', [BUILTIN_STD.key]);
    expect((await prepareTemplates(t.db, (m) => seen.push(m))).seeded).toBe('ALREADY');
    expect(await one('select count(*)::int n from tf_project')).toEqual({ n: 0 });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(
      /^기본 표준 STDV1 확인 — "TermFlow 기본 표준 v1"\(ACTIVE\), \d{4}-\d{2}-\d{2} /,
    );
    expect(seen[1]).toMatch(/^기본 표준 STDV1 없음 — .+ 적재 뒤 삭제됨/);
  });

  it('옛 승계 STDV1(created_by MIGRATION) → RETAILV1 "패션·유통 표준 v1", 그다음 범용 STDV1 적재', async () => {
    await truncateAll(t.pool);
    await t.pool.query(
      `insert into tf_project(project_key, project_nm, kind, created_by, updated_by)
       values ('STDV1', 'TermFlow 기본 표준 v1', 'TEMPLATE', 'MIGRATION', 'MIGRATION')`,
    );
    const r = await prepareTemplates(t.db, log);
    expect(r).toMatchObject({ renamed: true, seeded: 'SEEDED' });
    const rows = (
      await t.pool.query(
        'select project_key, project_nm, created_by, updated_by from tf_project order by project_id',
      )
    ).rows;
    expect(rows).toEqual([
      {
        project_key: RETAIL_TEMPLATE.key,
        project_nm: RETAIL_TEMPLATE.nm,
        created_by: 'MIGRATION',
        updated_by: 'SYSTEM',
      },
      {
        project_key: BUILTIN_STD.key,
        project_nm: BUILTIN_STD.nm,
        created_by: 'SYSTEM',
        updated_by: 'SYSTEM',
      },
    ]);
  });

  it('키 STDV1을 일반 프로젝트가 쓰고 있으면 건너뛴다(KEY_TAKEN)', async () => {
    await truncateAll(t.pool);
    await t.pool.query(
      `insert into tf_project(project_key, project_nm, created_by, updated_by)
       values ('STDV1', '사용자 프로젝트', 'admin', 'admin')`,
    );
    expect((await prepareTemplates(t.db, log)).seeded).toBe('KEY_TAKEN');
    expect(await one("select kind from tf_project where project_key = 'STDV1'")).toEqual({
      kind: 'PROJECT',
    });
  });

  it('범용 STDV1로 새 프로젝트 생성 — 전 항목 복사, 검토필요 0(Q9)', async () => {
    await truncateAll(t.pool);
    await prepareTemplates(t.db, log);
    const tpl = await one<{ id: number }>(
      "select project_id id from tf_project where project_key = 'STDV1'",
    );
    const u = await one<{ id: number }>(
      `insert into tf_user(login_id, user_nm, password_hash, is_sys_admin, created_by, updated_by)
       values ('sa', '관리자', 'x', true, 'test', 'test') returning user_id id`,
    );
    const s: CopySource = { kind: 'TEMPLATE', projectId: tpl.id, key: 'STDV1' };
    const plan: CopyPlan = {
      operation: 'CREATE',
      target: {
        projectKey: 'NEWP',
        projectNm: '새 프로젝트',
        description: null,
        kind: 'PROJECT',
        defaultDialect: 'POSTGRESQL',
      },
      sources: { bizAreas: s, terms: s, domainClasses: s, domains: s, codes: s, defaultColSets: s },
      bizCds: null,
      approvedOnly: true,
      creatorUserId: u.id,
      members: [],
      warnings: [],
    };
    const out = await executeCopy(t.db, plan, audit('sa', '127.0.0.1'));
    expect(out.c3Revalidation.reviewDomainCnt).toBe(0);
    expect(out.items.every((i) => i.copied === i.sourceCnt && i.skipped === 0)).toBe(true);
    expect(await countsOf('NEWP')).toEqual(await countsOf('STDV1'));
  });
});
