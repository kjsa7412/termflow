import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CopyPreviewResponse, ProjectCreateResponse, ProjectHome } from '@termflow/shared';
import { audit } from '../../src/common/audit/audit.js';
import { createDb, type Db } from '../../src/db/client.js';
import type { CopyPlan, CopySource } from '../../src/project/copy/copy-plan.js';
import {
  CopyFailedProblem,
  executeCopy,
  previewCopy,
} from '../../src/project/copy/project-copy.service.js';
import { Client, createTestApp, setTestEnv } from './setup/app.js';
import { createMigratedDatabase, FIXTURE_PASSWORD } from './setup/databases.js';
import { insertUsers, PHASE1, runSteps, tempReportRoot } from './setup/stdv1.js';

// T5.2 복사 엔진(STDV1 전 항목·5초·롤백) · T5.3 C3 재검증 · T5.4 미리보기 = 실제 · CR-01-1 시나리오(§13.2)
const A = audit('sysadmin', '127.0.0.1');
let pool: pg.Pool;
let db: Db;
let url: string;
let app: INestApplication;
let users: Record<string, number>;
let stdv1Id: number;
const rep = tempReportRoot('tf-copy-');

const pid = async (key: string) =>
  (await pool.query('select project_id from tf_project where project_key = $1', [key])).rows[0]
    ?.project_id as number | undefined;

function plan(
  key: string,
  sources: Partial<CopyPlan['sources']>,
  extra: Partial<CopyPlan> = {},
): CopyPlan {
  const s: CopySource = { kind: 'TEMPLATE', projectId: stdv1Id, key: 'STDV1' };
  return {
    operation: 'CREATE',
    target: {
      projectKey: key,
      projectNm: `${key} 테스트`,
      description: null,
      kind: 'PROJECT',
      defaultDialect: 'POSTGRESQL',
    },
    sources: {
      bizAreas: s,
      terms: s,
      domainClasses: s,
      domains: s,
      codes: s,
      defaultColSets: s,
      ...sources,
    },
    bizCds: null,
    approvedOnly: false,
    creatorUserId: users['sysadmin']!,
    members: [],
    warnings: [],
    ...extra,
  };
}

beforeAll(async () => {
  url = await createMigratedDatabase('t_copy');
  pool = new pg.Pool({ connectionString: url, max: 4 });
  db = createDb(pool);
  const r = await runSteps({ pool, db, url }, rep.dir, 'copy-p1', PHASE1);
  expect(r.ok).toBe(true);
  users = await insertUsers(pool);
  stdv1Id = (await pid('STDV1'))!;
  setTestEnv(url);
  app = await createTestApp();
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  rep.cleanup();
});

describe('복사 엔진(T5.2) — STDV1 전 항목', () => {
  it('항목별 건수 = STDV1, project_copy_log 8행, elapsed_ms 합 5초 이내, 출처·기본 세트·감사 COPY', async () => {
    const out = await executeCopy(db, plan('FULL1', {}), A);
    const byItem = Object.fromEntries(out.items.map((i) => [i.item, i.copied]));
    expect(byItem).toEqual({
      BIZ_AREA: 6,
      TERM: 1705,
      DOMAIN_CLS: 84,
      DOMAIN: 4587,
      CODE_CLS: 159,
      CODE: 991,
      DEFAULT_COL_SET: 1,
      DEFAULT_COL: 9,
    });
    expect(out.items.every((i) => i.skipped === 0 && i.sourceCnt === i.copied)).toBe(true);
    const log = await pool.query(
      'select item, elapsed_ms, source_kind, operation from project_copy_log where project_id = $1 order by copy_id',
      [out.projectId],
    );
    expect(log.rows).toHaveLength(8);
    const sum = log.rows.reduce((s, r) => s + Number(r.elapsed_ms), 0);
    console.log(
      `[test:db copy] STDV1 전 항목 복사: 전체 ${out.elapsedMs}ms, elapsed_ms 합 ${sum}ms — ${log.rows
        .map((r) => `${r.item} ${r.elapsed_ms}`)
        .join(' · ')}`,
    );
    expect(sum).toBeLessThan(5000);
    expect(out.elapsedMs).toBeLessThan(5000);
    // C3 생략(원본 동일) → review는 원본 그대로 293
    expect(out.c3Revalidation).toMatchObject({
      performed: false,
      reviewDomainCnt: 293,
      flaggedCnt: 0,
    });
    const origin = await pool.query(
      `select count(*) filter (where origin_project_id = $2)::int o, count(*) filter (where origin_id is null)::int n
         from std_domain where project_id = $1`,
      [out.projectId, stdv1Id],
    );
    expect(origin.rows[0]).toEqual({ o: 4587, n: 0 });
    const p = await pool.query(
      `select p.copied_from_project_id, s.origin_id = (select default_col_set_id from tf_project where project_id = $2) ok
         from tf_project p join std_default_col_set s on s.set_id = p.default_col_set_id where p.project_id = $1`,
      [out.projectId, stdv1Id],
    );
    expect(p.rows[0]).toEqual({ copied_from_project_id: stdv1Id, ok: true });
    const au = await pool.query(
      "select count(*)::int n from std_audit_log where project_id = $1 and action = 'COPY' and batch_id = $2",
      [out.projectId, out.batchId],
    );
    expect(au.rows[0]).toEqual({ n: 8 });
    const m = await pool.query(
      'select user_id, member_role from tf_project_member where project_id = $1',
      [out.projectId],
    );
    expect(m.rows).toEqual([{ user_id: users['sysadmin'], member_role: 'ADMIN' }]);
    // 코드구분의 업무구분은 새 프로젝트 행(biz_cd 자연키)
    const cross = await pool.query(
      `select count(*)::int n from std_code_cls c join prj_biz_area b on b.biz_area_id = c.biz_area_id
        where c.project_id = $1 and b.project_id <> $1`,
      [out.projectId],
    );
    expect(cross.rows[0]).toEqual({ n: 0 });
  });

  it('실패 주입(CODE 단계) → 전체 롤백, 오류에 step', async () => {
    await pool.query(`create or replace function t_fail_code() returns trigger language plpgsql as $$
      begin
        if exists (select 1 from tf_project where project_id = new.project_id and project_key = 'FAILX') then
          raise exception 'injected';
        end if;
        return new;
      end $$`);
    await pool.query(
      'create trigger t_fail_code before insert on std_code for each row execute function t_fail_code()',
    );
    try {
      const e = await executeCopy(db, plan('FAILX', {}), A).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(CopyFailedProblem);
      expect((e as CopyFailedProblem).step).toBe('CODE');
      expect((e as CopyFailedProblem).toProblem()).toMatchObject({
        status: 500,
        code: 'E_COPY_FAILED',
        step: 'CODE',
      });
      expect(await pid('FAILX')).toBeUndefined();
      const left = await pool.query(
        'select count(*)::int n from project_copy_log l where not exists (select 1 from tf_project p where p.project_id = l.project_id)',
      );
      expect(left.rows[0]).toEqual({ n: 0 });
    } finally {
      await pool.query('drop trigger t_fail_code on std_code');
    }
  });

  it('키 중복 → 409 E_PROJECT_KEY_DUP(부분 생성 없음)', async () => {
    const e = await executeCopy(db, plan('STDV1', {}), A).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'E_PROJECT_KEY_DUP' });
  });
});

describe('C3 재검증(T5.3)', () => {
  let prjx: number;
  let expected: number;
  beforeAll(async () => {
    // PRJX: STDV1 사본에서 용어 '매장' 물리약어를 바꾸고, 새 용어 '신규조각' + 그것을 쓰는 도메인을 추가
    const x = await executeCopy(db, plan('PRJX', {}), A);
    prjx = x.projectId;
    await pool.query(
      "update std_term set term_physical = 'STORE' where project_id = $1 and term_kor = '매장'",
      [prjx],
    );
    await pool.query(
      `insert into std_term (project_id, term_kor, term_physical, created_by, updated_by) values ($1, '신규조각', 'NEWP', 't', 't')`,
      [prjx],
    );
    await pool.query(
      `insert into std_domain (project_id, nm1, nm2, logical_nm, physical_nm, suffix, created_by, updated_by)
       values ($1, '신규조각', '번호', '신규조각번호', 'NEWP_NO', 'NO', 't', 't')`,
      [prjx],
    );
    await pool.query(
      "update std_term set status = 'PENDING' where project_id = $1 and term_kor in ('가격', '가공')",
      [prjx],
    );
    const r = await pool.query(
      `select count(*)::int n from std_domain where project_id = $1
          and '매장' in (nm1, nm2, nm3, nm4, nm5, nm6, nm7)`,
      [prjx],
    );
    expected = r.rows[0].n + 1;
    expect(expected).toBeGreaterThan(10);
  });

  it('도메인만 다른 원본(PRJX) → 수행, 달라진 행만 review + W_COPY_SOURCE_MIXED', async () => {
    const out = await executeCopy(
      db,
      plan('C3A', { domains: { kind: 'PROJECT', projectId: prjx, key: 'PRJX' } }),
      A,
    );
    expect(out.c3Revalidation.performed).toBe(true);
    expect(out.c3Revalidation.flaggedCnt).toBe(expected);
    expect(out.items.find((i) => i.item === 'DOMAIN')!.flagged).toBe(expected);
    expect(out.warnings.map((w) => w.code)).toContain('W_COPY_SOURCE_MIXED');
    expect(out.c3Revalidation.samples.length).toBeGreaterThan(0);
    const d = await pool.query(
      "select review_yn, review_note from std_domain where project_id = $1 and logical_nm = '신규조각번호'",
      [out.projectId],
    );
    expect(d.rows[0]).toEqual({
      review_yn: true,
      review_note: 'C3: 복사 후 L1 불일치(미등록 조각: 신규조각)',
    });
    const c = await pool.query(
      "select count(*)::int n from std_domain where project_id = $1 and review_note like 'C3:%'",
      [out.projectId],
    );
    expect(c.rows[0]).toEqual({ n: expected });
    const log = await pool.query(
      "select flagged_cnt, warnings from project_copy_log where project_id = $1 and item = 'DOMAIN'",
      [out.projectId],
    );
    expect(log.rows[0].flagged_cnt).toBe(expected);
    expect(log.rows[0].warnings[0].code).toBe('W_COPY_SOURCE_MIXED');
  });

  it('원본이 달라도 내용이 같으면(FULL1 = STDV1 사본) 수행하되 표시 0건', async () => {
    const full1 = (await pid('FULL1'))!;
    const out = await executeCopy(
      db,
      plan('C3B', { domains: { kind: 'PROJECT', projectId: full1, key: 'FULL1' } }),
      A,
    );
    expect(out.c3Revalidation).toMatchObject({
      performed: true,
      flaggedCnt: 0,
      reviewDomainCnt: 293,
    });
  });

  it('용어·도메인분류·도메인 원본이 같으면 생략', async () => {
    const src: CopySource = { kind: 'PROJECT', projectId: prjx, key: 'PRJX' };
    const out = await executeCopy(
      db,
      plan('C3C', { terms: src, domainClasses: src, domains: src }),
      A,
    );
    expect(out.c3Revalidation.performed).toBe(false);
    expect(out.c3Revalidation.flaggedCnt).toBe(0);
  });

  it('미리보기 건수 = 실제 복사 건수(승인 용어만·업무구분 선택·원본 혼합)', async () => {
    const p = plan(
      'PV1',
      {
        terms: { kind: 'PROJECT', projectId: prjx, key: 'PRJX' },
        codes: { kind: 'PROJECT', projectId: prjx, key: 'PRJX' },
      },
      { approvedOnly: true, bizCds: ['RP', 'PS'] },
    );
    const pv = await db.transaction((tx) => previewCopy(tx, p));
    const out = await executeCopy(db, p, A);
    expect(out.items.map((i) => [i.item, i.copied])).toEqual(
      pv.items.map((i) => [i.item, i.toCopy]),
    );
    const term = pv.items.find((i) => i.item === 'TERM')!;
    expect(term).toMatchObject({ sourceCnt: 1706, toCopy: 1704, toSkip: 2 });
    expect(pv.items.find((i) => i.item === 'BIZ_AREA')).toMatchObject({ sourceCnt: 6, toCopy: 2 });
    // 코드 원본(PRJX)이 업무구분 원본(STDV1)과 달라 미선택 업무구분의 코드구분은 "없는 업무구분" 경고
    expect(pv.warnings.map((w) => w.code)).toContain('W_COPY_BIZ_AREA_MISSING');
  });
});

describe('CR-01-1 시나리오(§13.2): 마법사 API로 STDV1 기반 생성 — 업무구분 3개, 도메인만 다른 프로젝트 원본', () => {
  let sa: Client;
  beforeAll(async () => {
    sa = new Client(app.getHttpServer());
    expect((await sa.login('sysadmin', FIXTURE_PASSWORD)).status).toBe(200);
  });
  const imports = (domainsKey = 'PRJX') => ({
    bizAreas: { source: 'TEMPLATE', sourceKey: 'STDV1', bizCds: ['RP', 'PS', 'AC'] },
    terms: { source: 'TEMPLATE', sourceKey: 'STDV1', approvedOnly: true },
    domainClasses: { source: 'TEMPLATE', sourceKey: 'STDV1' },
    domains: { source: 'PROJECT', sourceKey: domainsKey },
    codes: { source: 'TEMPLATE', sourceKey: 'STDV1' },
    defaultColSets: { source: 'TEMPLATE', sourceKey: 'STDV1' },
  });

  it('원본 후보 → 키 검사 → 미리보기 → 생성: 한 트랜잭션, 항목별 건수 = 미리보기, C3 응답·홈 배너 건수, 5초 이내', async () => {
    const src = await sa.get('/api/v1/projects/copy-sources');
    expect(src.status).toBe(200);
    const stdv1 = src.body.templates.find((t: { key: string }) => t.key === 'STDV1');
    expect(stdv1.counts).toMatchObject({
      bizArea: 6,
      term: 1705,
      domainCls: 84,
      domain: 4587,
      codeCls: 159,
      code: 991,
      defaultCol: 9,
    });
    expect(stdv1.bizAreas.map((b: { bizCd: string }) => b.bizCd)).toEqual([
      'AC',
      'BD',
      'CT',
      'GW',
      'PS',
      'RP',
    ]);
    expect(src.body.projects.map((p: { key: string }) => p.key)).toContain('PRJX');

    expect((await sa.get('/api/v1/projects/check-key?key=CR011')).body).toEqual({
      available: true,
    });
    expect((await sa.get('/api/v1/projects/check-key?key=STDV1')).body.available).toBe(false);
    expect((await sa.get('/api/v1/projects/check-key?key=cr1')).body.available).toBe(false);

    const pv = await sa.post('/api/v1/projects/copy-preview', { imports: imports() });
    expect(pv.status).toBe(200);
    const preview = pv.body as CopyPreviewResponse;
    expect(preview.c3Expected).toBe(true);

    const res = await sa.post('/api/v1/projects', {
      projectKey: 'CR011',
      projectNm: 'CR-01-1 시나리오',
      description: null,
      defaultDialect: 'POSTGRESQL',
      imports: imports(),
      members: [{ userId: users['editor1'], role: 'EDITOR' }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.headers['location']).toBe('/api/v1/projects/CR011');
    const out = res.body as ProjectCreateResponse;
    expect(out.items.map((i) => [i.item, i.copied])).toEqual(
      preview.items.map((i) => [i.item, i.toCopy]),
    );
    expect(out.items.find((i) => i.item === 'BIZ_AREA')).toMatchObject({ copied: 3, skipped: 3 });
    expect(out.c3Revalidation.performed).toBe(true);
    expect(out.c3Revalidation.flaggedCnt).toBeGreaterThan(0);
    expect(out.c3Revalidation.reviewListUrl).toBe('/projects/CR011/standards/domains?review=true');
    expect(out.warnings.map((w) => w.code)).toContain('W_COPY_SOURCE_MIXED');
    expect(out.elapsedMs).toBeLessThan(5000);
    console.log(
      `[test:db copy] CR-01-1 생성 ${out.elapsedMs}ms · C3 표시 ${out.c3Revalidation.flaggedCnt} · 검토 도메인 ${out.c3Revalidation.reviewDomainCnt}`,
    );

    const home = await sa.get('/api/v1/projects/CR011');
    expect(home.status).toBe(200);
    const h = home.body as ProjectHome;
    expect(h.reviewDomainCnt).toBe(out.c3Revalidation.reviewDomainCnt);
    expect(h.bizAreas.map((b) => b.bizCd)).toEqual(['AC', 'PS', 'RP']);
    expect(h.memberCnt).toBe(2);
    expect(h.project.copiedFrom).toEqual({ key: 'STDV1', nm: 'TermFlow 기본 표준 v1' });
    // 선택한 업무구분의 코드만(C4)
    const codes = await pool.query(
      `select distinct b.biz_cd from std_code_cls c join prj_biz_area b on b.biz_area_id = c.biz_area_id
         join tf_project p on p.project_id = c.project_id where p.project_key = 'CR011' order by 1`,
    );
    expect(codes.rows.map((r) => r.biz_cd)).toEqual(['AC', 'PS', 'RP']);
  });

  it('키 중복 409 E_PROJECT_KEY_DUP, 없는 원본 422 E_COPY_SOURCE_INVALID, 형식 오류 400', async () => {
    const body = (key: string, imp: object) => ({
      projectKey: key,
      projectNm: 'x',
      imports: imp,
      members: [],
    });
    const dup = await sa.post('/api/v1/projects', body('CR011', imports()));
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('E_PROJECT_KEY_DUP');
    const bad = await sa.post('/api/v1/projects', body('CR012', imports('NOPE')));
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0]).toMatchObject({
      code: 'E_COPY_SOURCE_INVALID',
      field: 'imports.domains.sourceKey',
    });
    // 템플릿을 PROJECT 원본으로 지정하는 것도 거부
    const wrongKind = await sa.post(
      '/api/v1/projects',
      body('CR013', { ...imports(), domains: { source: 'PROJECT', sourceKey: 'STDV1' } }),
    );
    expect(wrongKind.status).toBe(422);
    expect((await sa.post('/api/v1/projects', body('cr', imports()))).status).toBe(400);
    expect(await pid('CR012')).toBeUndefined();
  });

  it('C4: 업무구분을 비우면 코드도 비움(경고), 기본컬럼 비움이면 기본 세트 없음', async () => {
    const res = await sa.post('/api/v1/projects', {
      projectKey: 'EMPTY1',
      projectNm: '빈 프로젝트',
      imports: {
        bizAreas: { source: 'EMPTY' },
        terms: { source: 'TEMPLATE', sourceKey: 'STDV1' },
        domainClasses: { source: 'EMPTY' },
        domains: { source: 'EMPTY' },
        codes: { source: 'TEMPLATE', sourceKey: 'STDV1' },
        defaultColSets: { source: 'EMPTY' },
      },
    });
    expect(res.status).toBe(201);
    const out = res.body as ProjectCreateResponse;
    expect(out.items.filter((i) => i.copied > 0).map((i) => i.item)).toEqual(['TERM']);
    expect(out.items.find((i) => i.item === 'CODE_CLS')!.sourceKind).toBe('EMPTY');
    expect(out.warnings.map((w) => w.code)).toContain('W_COPY_CODES_EMPTIED');
    expect(out.c3Revalidation.performed).toBe(false);
    const p = await pool.query(
      "select default_col_set_id from tf_project where project_key = 'EMPTY1'",
    );
    expect(p.rows[0]).toEqual({ default_col_set_id: null });
    const log = await pool.query(
      "select count(*)::int n, count(*) filter (where source_kind = 'EMPTY')::int e from project_copy_log l join tf_project p using (project_id) where p.project_key = 'EMPTY1'",
    );
    expect(log.rows[0]).toEqual({ n: 8, e: 7 });
  });
});
