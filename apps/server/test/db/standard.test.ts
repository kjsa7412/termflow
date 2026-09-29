import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ApprovalPage,
  AuditLogItem,
  CodeClsDetail,
  CodeClsItem,
  DefaultColSetItem,
  DomainCalcResult,
  DomainClsPage,
  DomainPage,
  DomainRecalcResponse,
  Page,
  SearchResponse,
  TermPage,
} from '@termflow/shared';
import { TermCacheRegistry } from '../../src/autocomplete/term-cache-registry.js';
import { Client, createTestApp, setTestEnv } from './setup/app.js';
import { FIXTURE_PASSWORD, useTestDb } from './setup/databases.js';

// 단계 6 표준 사전 API(T6.2~T6.8·T6.10·T6.13): 용어·도메인분류·도메인·코드·기본컬럼·승인 큐·감사·검색 + 보관·템플릿·격리
const t = useTestDb('t_standard', { fixture: 'std_small' });
let app: INestApplication;
const P = '/api/v1/projects/PRJA/standards';
const pid: Record<string, number> = {};

beforeAll(async () => {
  setTestEnv(t.url);
  app = await createTestApp();
  const r = await t.pool.query('select project_key, project_id from tf_project');
  for (const row of r.rows) pid[row.project_key] = row.project_id;
});
afterAll(async () => {
  await app?.close();
});

async function as(login: string): Promise<Client> {
  const c = new Client(app.getHttpServer());
  expect((await c.login(login, FIXTURE_PASSWORD)).status).toBe(200);
  return c;
}
const auditRows = async (entityType: string, entityId: number) =>
  (
    await t.pool.query(
      'select action, actor, before_json, after_json, batch_id from std_audit_log where entity_type = $1 and entity_id = $2 order by audit_id',
      [entityType, entityId],
    )
  ).rows;

describe('용어(T6.2)', () => {
  it('목록: 검색·상태 필터·세그먼트 건수·정렬 화이트리스트·페이지', async () => {
    const v = await as('viewer');
    const all = await v.get(`${P}/terms?size=10`);
    expect(all.status).toBe(200);
    const page = all.body as TermPage;
    expect(page.total).toBe(50);
    expect(page.items).toHaveLength(10);
    expect(page.counts).toMatchObject({ all: 50, approved: 48, pending: 2, rejected: 0 });
    const pending = (await v.get(`${P}/terms?status=PENDING`)).body as TermPage;
    expect(pending.items.map((x) => x.termKor).sort()).toEqual(['용어49', '용어50']);
    const q = (await v.get(`${P}/terms?q=pa_t1&sort=termPhysical,desc`)).body as TermPage;
    expect(q.items[0]!.termPhysical).toBe('PA_T19');
    expect(q.total).toBe(11); // PA_T1, PA_T10~19
    expect((await v.get(`${P}/terms?sort=bogus,asc`)).status).toBe(400);
  });

  it('등록(PA): 201 APPROVED·감사 INSERT·캐시 무효화 / 한글 중복 409 / 물리약어 형식 422 / 같은 물리약어 경고(R8) / 편집자 403', async () => {
    const pa = await as('pa');
    const cache = app.get(TermCacheRegistry);
    const n0 = cache.recentInvalidations().length;
    const r = await pa.post(`${P}/terms`, {
      termKor: '위원회',
      termPhysical: 'CMTE',
      description: 'Committee',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.term).toMatchObject({
      termKor: '위원회',
      termPhysical: 'CMTE',
      status: 'APPROVED',
    });
    expect(r.body.warnings).toEqual([]);
    expect(cache.recentInvalidations().length).toBe(n0 + 1);
    expect(cache.recentInvalidations().at(-1)).toBe(pid['PRJA']);
    const a = await auditRows('TERM', r.body.term.termId);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: 'INSERT', actor: 'pa' });
    expect(a[0].after_json).toMatchObject({ termKor: '위원회', termPhysical: 'CMTE' });
    expect(a[0].after_json).not.toHaveProperty('createdBy');

    const dup = await pa.post(`${P}/terms`, { termKor: '위원회', termPhysical: 'CMT' });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: 'E_TERM_DUP', termId: r.body.term.termId });
    const fmt = await pa.post(`${P}/terms`, { termKor: '연구과제', termPhysical: 'RSCH-PRJ' });
    expect(fmt.status).toBe(422);
    expect(fmt.body.errors[0]).toMatchObject({
      code: 'E_TERM_PHYSICAL_FORMAT',
      field: 'termPhysical',
    });
    const lower = await pa.post(`${P}/terms`, { termKor: '소문자', termPhysical: 'abc' });
    expect(lower.status).toBe(422);
    const empty = await pa.post(`${P}/terms`, { termKor: ' ', termPhysical: 'X' });
    expect(empty.body.errors[0].code).toBe('E_TERM_KOR_EMPTY');

    const shared = await pa.post(`${P}/terms`, { termKor: '위원', termPhysical: 'CMTE' });
    expect(shared.status).toBe(201);
    expect(shared.body.warnings[0].code).toBe('W_TERM_PHYSICAL_SHARED');
    expect(shared.body.physicalConflicts).toEqual([
      expect.objectContaining({ termKor: '위원회', termPhysical: 'CMTE' }),
    ]);
    expect(shared.body.term.sharedCnt).toBe(1);
    // 라틴 문자는 대문자 저장(§3.5.5)
    const latin = await pa.post(`${P}/terms`, { termKor: 'id', termPhysical: 'ID' });
    expect(latin.body.term.termKor).toBe('ID');

    expect(
      (await (await as('editor')).post(`${P}/terms`, { termKor: '편집', termPhysical: 'EDT' }))
        .status,
    ).toBe(403);
  });

  it('check·상세(도메인 사용 수)·수정(감사 UPDATE)·삭제(검토대기 409, 승인 삭제 204)', async () => {
    const pa = await as('pa');
    const chk = await pa.get(`${P}/terms/check?termKor=위원회&termPhysical=CMTE`);
    expect(chk.body.korExists).toBe(true);
    expect(chk.body.physicalUsedBy.map((x: { termKor: string }) => x.termKor).sort()).toEqual([
      '위원',
      '위원회',
    ]);
    const t1 = (
      await t.pool.query(
        "select term_id from std_term where project_id = $1 and term_kor = '용어1'",
        [pid['PRJA']],
      )
    ).rows[0].term_id as number;
    const d = await pa.get(`${P}/terms/${t1}`);
    expect(d.status).toBe(200);
    expect(d.body.domainCnt).toBeGreaterThan(0);
    const up = await pa.put(`${P}/terms/${t1}`, {
      termKor: '용어1',
      termPhysical: 'PA_T1X',
      description: '바꿈',
      synonymRef: null,
    });
    expect(up.status).toBe(200);
    expect(up.body.term).toMatchObject({ termPhysical: 'PA_T1X', status: 'APPROVED' });
    const au = await auditRows('TERM', t1);
    expect(au.at(-1)).toMatchObject({ action: 'UPDATE' });
    expect(au.at(-1).before_json.termPhysical).toBe('PA_T1');
    expect(au.at(-1).after_json.termPhysical).toBe('PA_T1X');
    // 다른 용어의 한글로 바꾸면 409
    expect(
      (await pa.put(`${P}/terms/${t1}`, { termKor: '용어2', termPhysical: 'PA_T1X' })).status,
    ).toBe(409);
    const p49 = (
      await t.pool.query(
        "select term_id from std_term where project_id = $1 and term_kor = '용어49'",
        [pid['PRJA']],
      )
    ).rows[0].term_id as number;
    const del = await pa.delete(`${P}/terms/${p49}`);
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('E_TERM_PENDING_DELETE');
    const wi = (await pa.post(`${P}/terms`, { termKor: '삭제용', termPhysical: 'DELX' })).body.term
      .termId as number;
    expect((await pa.delete(`${P}/terms/${wi}`)).status).toBe(204);
    expect((await auditRows('TERM', wi)).map((x) => x.action)).toEqual(['INSERT', 'DELETE']);
    expect((await pa.get(`${P}/terms/${wi}`)).status).toBe(404);
  });
});

describe('승인 큐(T6.7) — §4.5 상태 전이 표', () => {
  let p49 = 0;
  let p50 = 0;
  beforeAll(async () => {
    const r = await t.pool.query(
      "select term_kor, term_id from std_term where project_id = $1 and term_kor in ('용어49', '용어50')",
      [pid['PRJA']],
    );
    for (const x of r.rows) {
      if (x.term_kor === '용어49') p49 = x.term_id;
      else p50 = x.term_id;
    }
  });

  it('목록·건수(검토대기 오래된 순), 충돌·사용 컬럼 정보', async () => {
    const pa = await as('pa');
    const c = await pa.get(`${P}/approvals/count`);
    expect(c.body).toEqual({ pending: 2 });
    const l = (await pa.get(`${P}/approvals`)).body as ApprovalPage;
    expect(l.items.map((x) => x.termKor)).toEqual(['용어49', '용어50']);
    expect(l.counts).toEqual({ pending: 2, processed: 0 });
    expect(l.items[0]).toHaveProperty('physicalConflicts');
    expect(l.items[0]).toHaveProperty('columnCnt');
  });

  it('PENDING → APPROVED(정정 후 승인: 물리약어 변경, 감사 APPROVE corrected), 다시 승인·반려 409', async () => {
    const pa = await as('pa');
    const bad = await pa.post(`${P}/approvals/${p49}/approve`, { termPhysical: 'x-y' });
    expect(bad.status).toBe(422);
    const r = await pa.post(`${P}/approvals/${p49}/approve`, {
      termPhysical: 'PA_T49C',
      description: '정정',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.term).toMatchObject({
      status: 'APPROVED',
      termPhysical: 'PA_T49C',
      reviewedBy: 'pa',
    });
    const a = await auditRows('TERM', p49);
    expect(a.at(-1)).toMatchObject({ action: 'APPROVE' });
    expect(a.at(-1).after_json.corrected).toBe(true);
    const again = await pa.post(`${P}/approvals/${p49}/approve`, {});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('E_TERM_NOT_PENDING');
    expect((await pa.post(`${P}/approvals/${p49}/reject`, { note: '사유' })).status).toBe(409);
  });

  it('PENDING → REJECTED(사유 필수 400, review_note·감사 REJECT) → 승인 큐 건수 0, REJECTED 삭제 허용', async () => {
    const pa = await as('pa');
    expect((await pa.post(`${P}/approvals/${p50}/reject`, { note: '' })).status).toBe(400);
    const r = await pa.post(`${P}/approvals/${p50}/reject`, { note: '용어50은 쓰지 않음' });
    expect(r.status).toBe(200);
    expect(r.body.term).toMatchObject({ status: 'REJECTED', reviewNote: '용어50은 쓰지 않음' });
    expect((await auditRows('TERM', p50)).at(-1)).toMatchObject({ action: 'REJECT' });
    expect((await pa.get(`${P}/approvals/count`)).body).toEqual({ pending: 0 });
    const done = (await pa.get(`${P}/approvals?state=PROCESSED`)).body as ApprovalPage;
    expect(done.items.map((x) => x.termKor).sort()).toEqual(['용어49', '용어50']);
    // 반려 용어는 L1 스냅샷에서 제외(미등록과 같다)
    const calc = await pa.post(`${P}/domains/calculate`, { nm1: '용어50', nm2: '분류1' });
    expect(calc.body.notFound).toContain('용어50');
    expect((await pa.delete(`${P}/terms/${p50}`)).status).toBe(204);
  });

  it('선택 승인: 하나라도 검토대기가 아니면 전체 409(원자적), 모두 검토대기면 일괄 승인', async () => {
    const ids: number[] = [];
    for (const k of ['대기1', '대기2']) {
      const r = await t.pool.query(
        `insert into std_term (project_id, term_kor, term_physical, status, created_by, updated_by)
         values ($1, $2, $3, 'PENDING', 'editor', 'editor') returning term_id`,
        [pid['PRJA'], k, k === '대기1' ? 'WAIT1' : 'WAIT2'],
      );
      ids.push(r.rows[0].term_id);
    }
    const pa = await as('pa');
    const mixed = await pa.post(`${P}/approvals/approve-batch`, { termIds: [...ids, p49] });
    expect(mixed.status).toBe(409);
    expect((await pa.get(`${P}/approvals/count`)).body).toEqual({ pending: 2 });
    const ok = await pa.post(`${P}/approvals/approve-batch`, { termIds: ids });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ approved: 2, termIds: ids });
    expect((await pa.get(`${P}/approvals/count`)).body).toEqual({ pending: 0 });
    // 편집자는 승인 불가(403), 조회자는 목록 조회 가능(§7.3 GET)
    expect((await (await as('editor')).post(`${P}/approvals/${ids[0]}/approve`, {})).status).toBe(
      403,
    );
    expect((await (await as('viewer')).get(`${P}/approvals`)).status).toBe(200);
  });
});

describe('도메인분류(T6.3)', () => {
  it('목록(사용 도메인 수·예시)·등록·접미어 중복 409·형식 422·길이 규칙 422', async () => {
    const pa = await as('pa');
    const l = (await pa.get(`${P}/domain-classes?size=50`)).body as DomainClsPage;
    expect(l.total).toBe(20);
    expect(l.items[0]!.suffix).toBe('SFX01');
    expect(l.items[0]!.domainCnt).toBe(5);
    expect(l.items[0]!.sample).not.toBeNull();
    const r = await pa.post(`${P}/domain-classes`, {
      suffix: 'MEMO',
      clsNm: '메모',
      colType: 'VARCHAR',
      colLength: 500,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.domainCls).toMatchObject({
      suffix: 'MEMO',
      typeText: 'VARCHAR(500)',
      domainCnt: 0,
    });
    const dup = await pa.post(`${P}/domain-classes`, {
      suffix: 'MEMO',
      clsNm: 'x',
      colType: 'TEXT',
    });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('E_DOMAIN_CLS_DUP');
    const fmt = await pa.post(`${P}/domain-classes`, {
      suffix: 'me-mo',
      clsNm: 'x',
      colType: 'TEXT',
    });
    expect(fmt.status).toBe(422);
    expect(fmt.body.errors[0].code).toBe('E_SUFFIX_FORMAT');
    const len = await pa.post(`${P}/domain-classes`, {
      suffix: 'AMT2',
      clsNm: 'x',
      colType: 'VARCHAR',
    });
    expect(len.body.errors[0].code).toBe('E_TYPE_LEN_MISSING');
    const sc = await pa.post(`${P}/domain-classes`, {
      suffix: 'RT2',
      clsNm: 'x',
      colType: 'NUMERIC',
      colLength: 3,
      colScale: 5,
    });
    expect(sc.body.errors[0].code).toBe('E_TYPE_LEN_RANGE');
  });

  it('사용 중 삭제: 409 경고(건수) → ?force=true 삭제·도메인 분류 연결 해제, 사용 중 접미어 변경 409', async () => {
    const pa = await as('pa');
    const l = (await pa.get(`${P}/domain-classes?q=SFX02`)).body as DomainClsPage;
    const c = l.items[0]!;
    const ren = await pa.put(`${P}/domain-classes/${c.domainClsId}`, {
      suffix: 'SFXX2',
      clsNm: c.clsNm,
      colType: c.colType,
      colLength: c.colLength,
      colScale: c.colScale,
    });
    expect(ren.status).toBe(409);
    expect(ren.body).toMatchObject({ code: 'E_DOMAIN_CLS_IN_USE', domainCnt: 5 });
    const del = await pa.delete(`${P}/domain-classes/${c.domainClsId}`);
    expect(del.status).toBe(409);
    expect(del.body).toMatchObject({ code: 'E_DOMAIN_CLS_IN_USE', domainCnt: 5 });
    const force = await pa.delete(`${P}/domain-classes/${c.domainClsId}?force=true`);
    expect(force.status).toBe(200);
    expect(force.body).toEqual({ unlinkedDomains: 5 });
    const left = await t.pool.query(
      "select count(*)::int n from std_domain where project_id = $1 and suffix = 'SFX02' and domain_cls_id is null and col_type is not null",
      [pid['PRJA']],
    );
    expect(left.rows[0].n).toBe(5); // 타입은 유지(§4.8)
    expect((await auditRows('DOMAIN_CLS', c.domainClsId)).at(-1).action).toBe('DELETE');
  });
});

describe('도메인(T6.4)', () => {
  it('calculate(조회자): L1 조각·물리명·접미어→타입·중복 표시', async () => {
    const v = await as('viewer');
    const r = await v.post(`${P}/domains/calculate`, { nm1: '용어3', nm2: '분류4' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const c = r.body as DomainCalcResult;
    expect(c).toMatchObject({
      logicalNm: '용어3분류4',
      physicalNm: null,
      assembledPhysical: 'PA_T3_분류4',
    });
    // 분류4는 용어가 아니라 미등록 → 물리명 NULL(R15), 검토 사유
    expect(c.notFound).toEqual(['분류4']);
    expect(c.reviewReasons[0]).toMatch(/미등록 조각/);
    expect(c.pieces).toEqual([
      { kor: '용어3', physical: 'PA_T3', matched: true, numeric: false },
      { kor: '분류4', physical: '분류4', matched: false, numeric: false },
    ]);
  });

  it('등록: L1 계산 저장 · 미등록 조각 → 물리명 NULL + 검토 · 논리명 중복 409 · 수기 타입 · 목록 필터(?review=true 등)', async () => {
    const pa = await as('pa');
    // 조각 용어: 가격(PRICE)·인하(REDU)·금액(AMT) + 접미어 AMT → BIGINT
    for (const [k, p] of [
      ['가격', 'PRICE'],
      ['인하', 'REDU'],
      ['금액', 'AMT'],
    ] as const)
      expect((await pa.post(`${P}/terms`, { termKor: k, termPhysical: p })).status).toBe(201);
    expect(
      (await pa.post(`${P}/domain-classes`, { suffix: 'AMT', clsNm: '금액', colType: 'BIGINT' }))
        .status,
    ).toBe(201);
    const r = await pa.post(`${P}/domains`, { nm1: '가격', nm2: '인하', nm3: '금액' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.domain).toMatchObject({
      logicalNm: '가격인하금액',
      physicalNm: 'PRICE_REDU_AMT',
      suffix: 'AMT',
      colType: 'BIGINT',
      typeText: 'BIGINT',
      typeSource: 'AUTO',
      reviewYn: false,
    });
    const dup = await pa.post(`${P}/domains`, { nm1: '가격인하', nm2: '금액' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('E_DOMAIN_DUP');
    const rev = await pa.post(`${P}/domains`, { nm1: '가격', nm2: '마찰', nm3: '금액' });
    expect(rev.status).toBe(201);
    expect(rev.body.domain).toMatchObject({ physicalNm: null, reviewYn: true, colType: 'BIGINT' });
    expect(rev.body.domain.reviewNote).toMatch(/미등록 조각: 마찰/);
    const manual = await pa.post(`${P}/domains`, {
      nm1: '가격',
      nm2: '금액',
      typeSource: 'MANUAL',
      colType: 'NUMERIC',
      colLength: 15,
      colScale: 2,
    });
    expect(manual.body.domain).toMatchObject({ typeSource: 'MANUAL', typeText: 'NUMERIC(15,2)' });
    const noType = await pa.post(`${P}/domains`, {
      nm1: '인하',
      nm2: '금액',
      typeSource: 'MANUAL',
    });
    expect(noType.status).toBe(422);
    expect(noType.body.errors[0].code).toBe('E_TYPE_MISSING');

    const review = (await pa.get(`${P}/domains?review=true&size=100`)).body as DomainPage;
    expect(review.items.every((d) => d.reviewYn)).toBe(true);
    expect(review.items.map((d) => d.logicalNm)).toContain('가격마찰금액');
    expect(review.counts.all).toBeGreaterThanOrEqual(103);
    const np = (await pa.get(`${P}/domains?noPhysical=true`)).body as DomainPage;
    expect(np.items.map((d) => d.logicalNm)).toEqual(['가격마찰금액']);
    const man = (await pa.get(`${P}/domains?typeSource=MANUAL`)).body as DomainPage;
    expect(man.items.map((d) => d.logicalNm)).toEqual(['가격금액']);
    const sfx = (await pa.get(`${P}/domains?suffix=amt`)).body as DomainPage;
    expect(sfx.total).toBe(3);
  });

  it('수정: 조각 변경 시 L1 재계산 · 삭제: 컬럼 연결 해제 수', async () => {
    const pa = await as('pa');
    const d = ((await pa.get(`${P}/domains?q=가격마찰금액`)).body as DomainPage).items[0]!;
    // 미등록 조각 '마찰'을 용어로 등록하고 조각을 그대로 저장하면 물리명이 채워지고 검토 해제
    expect((await pa.post(`${P}/terms`, { termKor: '마찰', termPhysical: 'FRIC' })).status).toBe(
      201,
    );
    const up = await pa.put(`${P}/domains/${d.domainId}`, {
      nm1: '가격',
      nm2: '마찰',
      nm3: '금액',
    });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect(up.body.domain).toMatchObject({ physicalNm: 'PRICE_FRIC_AMT', reviewYn: false });
    const detail = await pa.get(`${P}/domains/${d.domainId}`);
    expect(detail.body.pieces.map((p: { matched: boolean }) => p.matched)).toEqual([
      true,
      true,
      true,
    ]);
    // 컬럼이 참조하는 도메인 삭제 → SET NULL
    const used = (
      await t.pool.query(
        'select domain_id from prj_column where project_id = $1 and domain_id is not null limit 1',
        [pid['PRJA']],
      )
    ).rows[0].domain_id as number;
    const del = await pa.delete(`${P}/domains/${used}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ unlinkedColumns: 1 });
    expect((await auditRows('DOMAIN', used)).at(-1).action).toBe('DELETE');
  });

  it('재계산 REVIEW_ONLY: {updated, stillReview} + 감사 IMPORT(batch_id), MANUAL 타입 유지', async () => {
    const pa = await as('pa');
    // 검토필요 도메인 1건: 미등록 조각 → 용어 등록 후 재계산으로 해소
    const r = await pa.post(`${P}/domains`, { nm1: '인하', nm2: '폭', nm3: '금액' });
    expect(r.body.domain.reviewYn).toBe(true);
    expect((await pa.post(`${P}/terms`, { termKor: '폭', termPhysical: 'WDTH' })).status).toBe(201);
    const rc = await pa.post(`${P}/domains/recalculate`, { scope: 'REVIEW_ONLY' });
    expect(rc.status, JSON.stringify(rc.body)).toBe(200);
    const out = rc.body as DomainRecalcResponse;
    expect(out).toMatchObject({ scope: 'REVIEW_ONLY' });
    expect(out.updated).toBeGreaterThanOrEqual(1);
    expect(out.resolved).toBeGreaterThanOrEqual(1);
    expect(typeof out.stillReview).toBe('number');
    const row = out.report.find((x) => x.logicalNm === '인하폭금액')!;
    expect(row.changes['physicalNm']).toEqual([null, 'REDU_WDTH_AMT']);
    expect(row.reviewYn).toBe(false);
    const a = await auditRows('DOMAIN', r.body.domain.domainId);
    expect(a.at(-1)).toMatchObject({ action: 'IMPORT', batch_id: out.batchId });
    // 픽스처의 검토 도메인(논리명 ≠ 조각 연결)은 검토 유지
    expect(out.stillReview).toBeGreaterThanOrEqual(4);
    // ALL_AUTO: 도메인분류 타입 변경을 AUTO 도메인에만 반영(MANUAL 유지)
    const amt = ((await pa.get(`${P}/domain-classes?q=AMT`)).body as DomainClsPage).items.find(
      (c) => c.suffix === 'AMT',
    )!;
    const cu = await pa.put(`${P}/domain-classes/${amt.domainClsId}`, {
      suffix: 'AMT',
      clsNm: '금액',
      colType: 'NUMERIC',
      colLength: 18,
      colScale: null,
    });
    expect(cu.body.warnings[0].code).toBe('W_DOMAIN_RECALC_NEEDED');
    const all = (await pa.post(`${P}/domains/recalculate`, { scope: 'ALL_AUTO' }))
      .body as DomainRecalcResponse;
    expect(all.updated).toBeGreaterThanOrEqual(2);
    const types = await t.pool.query(
      "select logical_nm, type_source, col_type, col_length from std_domain where project_id = $1 and suffix = 'AMT' order by domain_id",
      [pid['PRJA']],
    );
    expect(types.rows).toEqual([
      { logical_nm: '가격인하금액', type_source: 'AUTO', col_type: 'NUMERIC', col_length: 18 },
      { logical_nm: '가격마찰금액', type_source: 'AUTO', col_type: 'NUMERIC', col_length: 18 },
      { logical_nm: '가격금액', type_source: 'MANUAL', col_type: 'NUMERIC', col_length: 15 },
      { logical_nm: '인하폭금액', type_source: 'AUTO', col_type: 'NUMERIC', col_length: 18 },
    ]);
    expect(
      (await (await as('editor')).post(`${P}/domains/recalculate`, { scope: 'ALL_AUTO' })).status,
    ).toBe(403);
  });
});

describe('코드구분·코드(T6.5)', () => {
  it('업무구분 소속·(업무구분, 코드구분) 중복 409·사용 중지 업무구분 422·다른 프로젝트 업무구분 422', async () => {
    const pa = await as('pa');
    const biz = (await pa.get('/api/v1/projects/PRJA/biz-areas')).body as {
      bizCd: string;
      bizAreaId: number;
    }[];
    const rp = biz.find((b) => b.bizCd === 'RP')!.bizAreaId;
    const ps = biz.find((b) => b.bizCd === 'PS')!.bizAreaId;
    const list = (await pa.get(`${P}/code-classes?bizAreaId=${rp}`)).body as Page<CodeClsItem>;
    expect(list.total).toBe(3);
    expect(list.items[0]).toMatchObject({ bizCd: 'RP', codeCnt: 6 });
    const c = await pa.post(`${P}/code-classes`, {
      bizAreaId: rp,
      codeCls: '900',
      codeClsNm: '진행상태',
    });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    // 같은 코드구분 값이 다른 업무구분에는 있어도 된다(쌍으로 판정)
    expect(
      (await pa.post(`${P}/code-classes`, { bizAreaId: ps, codeCls: '900', codeClsNm: '다른' }))
        .status,
    ).toBe(201);
    const dup = await pa.post(`${P}/code-classes`, {
      bizAreaId: rp,
      codeCls: '900',
      codeClsNm: '또',
    });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('E_CODE_CLS_DUP');
    // PS 사용 중지 → 새 코드구분 422
    await t.pool.query('update prj_biz_area set use_yn = false where biz_area_id = $1', [ps]);
    const off = await pa.post(`${P}/code-classes`, {
      bizAreaId: ps,
      codeCls: '901',
      codeClsNm: 'x',
    });
    expect(off.status).toBe(422);
    expect(off.body.errors[0].code).toBe('E_BIZ_AREA_INACTIVE');
    await t.pool.query('update prj_biz_area set use_yn = true where biz_area_id = $1', [ps]);
    const other = (
      await t.pool.query(
        "select biz_area_id from prj_biz_area where project_id = $1 and biz_cd = 'RP'",
        [pid['PRJB']],
      )
    ).rows[0].biz_area_id as number;
    const x = await pa.post(`${P}/code-classes`, {
      bizAreaId: other,
      codeCls: '902',
      codeClsNm: 'x',
    });
    expect(x.status).toBe(422);
    expect(x.body.errors[0].code).toBe('E_BIZ_AREA_NOT_FOUND');
  });

  it('코드 CRUD·중복 409·삭제 시 코드 CASCADE·참조 컬럼 수', async () => {
    const pa = await as('pa');
    const cls = ((await pa.get(`${P}/code-classes?q=진행상태`)).body as Page<CodeClsItem>)
      .items[0]!;
    const a = await pa.post(`${P}/code-classes/${cls.codeClsId}/codes`, {
      code: '10',
      codeNm: '신청',
      sortOrder: 1,
    });
    expect(a.status).toBe(201);
    expect(
      (await pa.post(`${P}/code-classes/${cls.codeClsId}/codes`, { code: '10', codeNm: 'x' })).body
        .code,
    ).toBe('E_CODE_DUP');
    await pa.post(`${P}/code-classes/${cls.codeClsId}/codes`, {
      code: '20',
      codeNm: '진행',
      sortOrder: 2,
    });
    const up = await pa.put(`${P}/code-classes/${cls.codeClsId}/codes/${a.body.codeId}`, {
      code: '10',
      codeNm: '신청(접수)',
      sortOrder: 1,
      isActive: false,
    });
    expect(up.body).toMatchObject({ codeNm: '신청(접수)', isActive: false });
    const detail = (await pa.get(`${P}/code-classes/${cls.codeClsId}?includeInactive=false`))
      .body as CodeClsDetail;
    expect(detail.codes.map((x) => x.code)).toEqual(['20']);
    expect(detail.codeCls).toMatchObject({ codeCnt: 2, activeCodeCnt: 1 });
    // 컬럼이 참조하는 코드구분 삭제 → 참조 수 응답, code_cls_id SET NULL
    const usedCls = (
      await t.pool.query(
        'select code_cls_id from prj_column where project_id = $1 and code_cls_id is not null',
        [pid['PRJA']],
      )
    ).rows[0].code_cls_id as number;
    const del = await pa.delete(`${P}/code-classes/${usedCls}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ deletedCodes: 6, affectedColumns: 1 });
    expect(
      (await t.pool.query('select count(*)::int n from std_code where code_cls_id = $1', [usedCls]))
        .rows[0].n,
    ).toBe(0);
    expect(
      (await pa.delete(`${P}/code-classes/${cls.codeClsId}/codes/${a.body.codeId}`)).status,
    ).toBe(204);
  });
});

describe('기본컬럼 세트(T6.6)', () => {
  it('세트 추가(기본 아님)·세트명 중복 409·구성 교체(ID 유지·물리명 중복 409)·기본 세트 지정(프로젝트 동기화)·삭제 규칙', async () => {
    const pa = await as('pa');
    const sets = (await pa.get(`${P}/default-column-sets`)).body as DefaultColSetItem[];
    expect(sets).toHaveLength(1);
    const base = sets[0]!;
    expect(base).toMatchObject({ setNm: '기본', isDefault: true, colCnt: 9, columnRefCnt: 1 });
    const n = await pa.post(`${P}/default-column-sets`, { setNm: '이력형', description: null });
    expect(n.status).toBe(201);
    expect(n.body.isDefault).toBe(false);
    expect((await pa.post(`${P}/default-column-sets`, { setNm: '이력형' })).body.code).toBe(
      'E_DEFAULT_COL_SET_DUP',
    );
    // 기본 세트 구성: 순서 뒤집기 + 1개 삭제 + 1개 추가 — 기존 ID 유지(컬럼 참조 보존)
    const cols = base.columns;
    const body = [
      ...cols
        .slice(1)
        .reverse()
        .map((c) => ({
          defaultColId: c.defaultColId as number | null,
          logicalNm: c.logicalNm,
          physicalNm: c.physicalNm,
          isPk: c.isPk,
          dataType: c.dataType,
          dataLength: c.dataLength,
          dataScale: c.dataScale,
          isNullable: c.isNullable,
          defaultVal: c.defaultVal,
          colComment: c.colComment,
        })),
      {
        defaultColId: null,
        logicalNm: '삭제여부',
        physicalNm: 'DEL_YN',
        isPk: false,
        dataType: 'CHAR' as const,
        dataLength: 1,
        dataScale: null,
        isNullable: false,
        defaultVal: "'N'",
        colComment: null,
      },
    ];
    const put = await pa.put(`${P}/default-column-sets/${base.setId}/columns`, { columns: body });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const after = put.body as DefaultColSetItem;
    expect(after.columns).toHaveLength(9);
    expect(after.columns[0]!.defaultColId).toBe(cols[8]!.defaultColId);
    expect(after.columns.at(-1)!.physicalNm).toBe('DEL_YN');
    // 첫 컬럼(WRK_RMK, 컬럼 참조 1)은 삭제 → 테이블 컬럼 default_col_id SET NULL
    expect(after.columnRefCnt).toBe(0);
    const dupPhys = await pa.put(`${P}/default-column-sets/${base.setId}/columns`, {
      columns: [body[0], { ...body[1], defaultColId: null, physicalNm: body[0]!.physicalNm }],
    });
    expect(dupPhys.status).toBe(409);
    expect(dupPhys.body.code).toBe('E_DEFAULT_COL_DUP');
    // 기본 세트 삭제는 다른 세트가 있으면 409
    expect((await pa.delete(`${P}/default-column-sets/${base.setId}`)).body.code).toBe(
      'E_DEFAULT_COL_SET_DEFAULT',
    );
    const d = await pa.put(`${P}/default-column-sets/${n.body.setId}/default`);
    expect(d.status).toBe(200);
    expect(d.body.isDefault).toBe(true);
    const p = await t.pool.query(
      'select default_col_set_id from tf_project where project_id = $1',
      [pid['PRJA']],
    );
    expect(p.rows[0].default_col_set_id).toBe(n.body.setId);
    const def = await t.pool.query(
      'select count(*)::int n from std_default_col_set where project_id = $1 and is_default',
      [pid['PRJA']],
    );
    expect(def.rows[0].n).toBe(1);
    expect((await pa.delete(`${P}/default-column-sets/${base.setId}`)).status).toBe(204);
  });
});

describe('감사 로그(T6.8)', () => {
  it('INSERT/UPDATE/DELETE/APPROVE/REJECT/IMPORT/COPY 조회, 엔티티 이력 필터는 COPY 요약 제외', async () => {
    // COPY: STDS 기반 새 프로젝트 생성(항목별 요약 행)
    const sa = await as('sysadmin');
    const c = await sa.post('/api/v1/projects', {
      projectKey: 'PRJC',
      projectNm: '프로젝트 C',
      description: null,
      defaultDialect: 'POSTGRESQL',
      imports: {
        bizAreas: { source: 'TEMPLATE', sourceKey: 'STDS' },
        terms: { source: 'TEMPLATE', sourceKey: 'STDS' },
        domainClasses: { source: 'TEMPLATE', sourceKey: 'STDS' },
        domains: { source: 'TEMPLATE', sourceKey: 'STDS' },
        codes: { source: 'TEMPLATE', sourceKey: 'STDS' },
        defaultColSets: { source: 'TEMPLATE', sourceKey: 'STDS' },
      },
      members: [],
    });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const copy = await sa.get('/api/v1/projects/PRJC/standards/audit-logs?action=COPY');
    expect(copy.body.total).toBe(8);
    const pa = await as('pa');
    for (const action of ['INSERT', 'UPDATE', 'DELETE', 'APPROVE', 'REJECT', 'IMPORT']) {
      const r = (await pa.get(`${P}/audit-logs?action=${action}&size=5`))
        .body as Page<AuditLogItem>;
      expect(r.total, action).toBeGreaterThan(0);
    }
    const upd = (
      (await pa.get(`${P}/audit-logs?action=UPDATE&entityType=TERM`)).body as Page<AuditLogItem>
    ).items;
    expect(upd.find((x) => x.changedFields.includes('termPhysical'))).toBeDefined();
    const t1 = (
      await t.pool.query(
        "select term_id from std_term where project_id = $1 and term_kor = '용어1'",
        [pid['PRJA']],
      )
    ).rows[0].term_id as number;
    const hist = (await pa.get(`${P}/audit-logs?entityType=TERM&entityId=${t1}`))
      .body as Page<AuditLogItem>;
    expect(hist.items.map((x) => x.action)).toEqual(['UPDATE']);
    const today = new Date().toISOString().slice(0, 10);
    expect(
      (
        (await pa.get(`${P}/audit-logs?from=${today}&to=${today}&actor=pa`))
          .body as Page<AuditLogItem>
      ).total,
    ).toBeGreaterThan(0);
    expect((await pa.get(`${P}/audit-logs?from=bad`)).status).toBe(400);
  });
});

describe('검색(T6.10)·보관·템플릿·격리(T6.13)', () => {
  it('P/search: 현재 프로젝트 범위만, 종류별 5건, 정확 일치 우선', async () => {
    const v = await as('viewer');
    const r = (await v.get('/api/v1/projects/PRJA/search?q=용어1')).body as SearchResponse;
    expect(r.terms.length).toBeLessThanOrEqual(5);
    expect(r.terms[0]!.termKor).toBe('용어1');
    expect(r.terms.every((x) => (x.termPhysical ?? '').startsWith('PA_'))).toBe(true);
    expect(r.domains.length).toBe(5);
    expect(r.tables).toEqual([]);
    const b = (await v.get('/api/v1/projects/PRJA/search?q=PB_T1')).body as SearchResponse;
    expect(b.terms).toEqual([]); // PRJB의 물리약어는 보이지 않는다
    expect((await v.get('/api/v1/projects/PRJA/search?q=')).status).toBe(400);
    expect((await v.get('/api/v1/projects/PRJB/search?q=x')).status).toBe(404);
  });

  it('한 프로젝트의 표준 변경이 다른 프로젝트에 영향 없음(CR-01-2)', async () => {
    const b = await t.pool.query(
      "select term_physical from std_term where project_id = $1 and term_kor = '용어1'",
      [pid['PRJB']],
    );
    expect(b.rows[0].term_physical).toBe('PB_T1');
    const s = await t.pool.query(
      "select count(*)::int n from std_term where project_id = $1 and term_kor in ('위원회', '가격')",
      [pid['STDS']],
    );
    expect(s.rows[0].n).toBe(0);
  });

  it('템플릿(STDS): 시스템 관리자 편집 허용, 비SA 404', async () => {
    const sa = await as('sysadmin');
    const r = await sa.post('/api/v1/projects/STDS/standards/terms', {
      termKor: '템플릿용어',
      termPhysical: 'TPLT',
    });
    expect(r.status).toBe(201);
    expect((await (await as('pa')).get('/api/v1/projects/STDS/standards/terms')).status).toBe(404);
    expect(
      (
        await (
          await as('pa')
        ).post('/api/v1/projects/STDS/standards/terms', { termKor: 'x', termPhysical: 'X' })
      ).status,
    ).toBe(404);
  });

  it('보관 프로젝트: 조회 200, 모든 표준 쓰기 409 E_PROJECT_READONLY', async () => {
    await t.pool.query("update tf_project set status = 'ARCHIVED' where project_key = 'PRJB'");
    try {
      const pa = await as('pa');
      const B = '/api/v1/projects/PRJB/standards';
      expect((await pa.get(`${B}/terms`)).status).toBe(200);
      for (const [m, path, body] of [
        ['post', `${B}/terms`, { termKor: 'x', termPhysical: 'X' }],
        ['post', `${B}/domain-classes`, { suffix: 'X', clsNm: 'x', colType: 'TEXT' }],
        ['post', `${B}/domains`, { nm1: 'x' }],
        ['post', `${B}/domains/recalculate`, { scope: 'REVIEW_ONLY' }],
        ['post', `${B}/default-column-sets`, { setNm: 'x' }],
        ['post', `${B}/approvals/approve-batch`, { termIds: [1] }],
      ] as const) {
        const r = await pa.post(path, body);
        expect(r.status, `${m} ${path}`).toBe(409);
        expect(r.body.code).toBe('E_PROJECT_READONLY');
      }
    } finally {
      await t.pool.query("update tf_project set status = 'ACTIVE' where project_key = 'PRJB'");
    }
  });
});
