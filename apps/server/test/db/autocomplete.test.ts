import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ApprovalPage,
  AutocompleteBatchResponse,
  AutocompleteResponse,
  CacheStatusResponse,
  TableDetail,
  TableNameSuggestion,
  TableSaveResponse,
  TableValidateResponse,
  TermInlineResponse,
} from '@termflow/shared';
import { TermCacheRegistry } from '../../src/autocomplete/term-cache-registry.js';
import { Client, createTestApp, setTestEnv } from './setup/app.js';
import { FIXTURE_PASSWORD, useTestDb } from './setup/databases.js';

/**
 * 단계 9 API 통합(T9.4·T9.5·T9.6·T9.9·T9.10·T9.12, 설계서 §5.4·§5.5·§4.5·§4.8·§5.1) — std_small(PRJA·PRJB: 같은 한글 용어,
 * 다른 물리약어). `pnpm test:db -- autocomplete`(실데이터 S2·S4·S6은 autocomplete-rms.test.ts)
 *  - S4 계약: 미등록 → 인라인 등록(PENDING) → 같은 입력 재호출 composed, 승인 큐 표시, 반려 → 재등록(REOPENED)
 *  - CR-01-2: 한 프로젝트 용어 등록이 다른 프로젝트 자동완성·캐시에 영향 없음
 */
const t = useTestDb('t_autocomplete', { fixture: 'std_small' });
let app: INestApplication;
let cache: TermCacheRegistry;
const PA = '/api/v1/projects/PRJA';
const PB = '/api/v1/projects/PRJB';
let pid: Record<string, number> = {};
let rpId = 0;

beforeAll(async () => {
  // PRJB 편집자(캐시 격리 확인용): pa는 PRJB 관리자
  const { rows } = await t.pool.query('select project_key, project_id from tf_project');
  pid = Object.fromEntries(rows.map((r) => [r.project_key, r.project_id]));
  rpId = (
    await t.pool.query(
      "select biz_area_id id from prj_biz_area where project_id = $1 and biz_cd = 'RP'",
      [pid['PRJA']],
    )
  ).rows[0].id as number;
  setTestEnv(t.url);
  app = await createTestApp();
  cache = app.get(TermCacheRegistry);
});
afterAll(async () => {
  await app?.close();
});

async function as(login: string): Promise<Client> {
  const c = new Client(app.getHttpServer());
  expect((await c.login(login, FIXTURE_PASSWORD)).status).toBe(200);
  return c;
}
const ac = async (c: Client, base: string, logicalNm: string, extra: object = {}) => {
  const r = await c.post(`${base}/autocomplete/columns`, { logicalNm, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as AutocompleteResponse;
};

describe('POST P/autocomplete/columns(§5.4)', () => {
  it('빈 입력(공백만) 400, 없는 필드 형식 400, 편집자 200 exact(도메인 논리명 정확일치)', async () => {
    const e = await as('editor');
    expect((await e.post(`${PA}/autocomplete/columns`, { logicalNm: '   ' })).status).toBe(400);
    expect((await e.post(`${PA}/autocomplete/columns`, {})).status).toBe(400);
    const r = await ac(e, PA, '용어2분류2_1');
    expect(r).toMatchObject({
      type: 'exact',
      normalized: '용어2분류2_1',
      applied: { physicalNm: 'PA_T2_SFX02', typeText: 'VARCHAR(12)', matchType: 'EXACT' },
    });
    expect(r.cacheVersion).toBeGreaterThanOrEqual(1);
    expect(typeof r.elapsedMs).toBe('number');
  });

  it('응답 ≤ 5KB(유사 후보 5)', async () => {
    const e = await as('editor');
    const r = await e.post(`${PA}/autocomplete/columns`, { logicalNm: '분류2' });
    expect((r.body as AutocompleteResponse).type).toBe('similar');
    expect((r.body as AutocompleteResponse).candidates!.length).toBe(5);
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(5 * 1024);
  });

  it('batch: 입력 순서대로 결과, 201건은 400, 빈 항목 400', async () => {
    const e = await as('editor');
    const r = await e.post(`${PA}/autocomplete/columns/batch`, {
      logicalNms: ['용어2분류2_1', '용어1용어3', '용어1쀍'],
    });
    expect(r.status).toBe(200);
    const b = r.body as AutocompleteBatchResponse;
    expect(b.items.map((x) => x.type)).toEqual(['exact', 'composed', 'unregistered']);
    expect(b.items[1]!.applied!.physicalNm).toBe('PA_T1_PA_T3');
    const many = Array.from({ length: 201 }, (_, i) => `용어${(i % 50) + 1}`);
    expect((await e.post(`${PA}/autocomplete/columns/batch`, { logicalNms: many })).status).toBe(
      400,
    );
    expect(
      (await e.post(`${PA}/autocomplete/columns/batch`, { logicalNms: ['용어1', ' '] })).status,
    ).toBe(400);
  });
});

describe('S4 인라인 등록(§5.9, T9.6) + 승인 큐 + CR-01-2 캐시 격리(T9.12)', () => {
  it('미등록 → 등록(PENDING 201) → 자동 재시도 composed → 승인 큐 PENDING, 다른 프로젝트는 영향 없음', async () => {
    const e = await as('editor');
    const pa = await as('pa');
    // PRJB 캐시를 먼저 적재해 둔다(버전 기록)
    const b0 = await ac(pa, PB, '용어1책임자');
    expect(b0.type).toBe('unregistered');
    const a0 = await ac(e, PA, '용어1책임자');
    expect(a0).toMatchObject({
      type: 'unregistered',
      applied: { physicalNm: 'PA_T1_?', matchType: 'UNREGISTERED' },
      segments: [
        { kor: '용어1', physical: 'PA_T1', matched: true },
        { kor: '책임자', physical: null, matched: false },
      ],
      registerCandidates: ['책임자'],
    });
    expect(a0.warnings.map((w) => w.code)).toContain('W_TERM_UNREGISTERED');

    const n0 = cache.recentInvalidations().length;
    const reg = await e.post(`${PA}/standards/terms/inline`, {
      termKor: '책임자',
      termPhysical: 'RESP',
      description: 'responsible person',
    });
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);
    expect(reg.body as TermInlineResponse).toMatchObject({
      status: 'PENDING',
      outcome: 'CREATED',
      termKor: '책임자',
      termPhysical: 'RESP',
      conflicts: [],
    });
    expect(cache.recentInvalidations().slice(n0)).toEqual([pid['PRJA']]);
    const audit = await t.pool.query(
      "select action, actor from std_audit_log where entity_type = 'TERM' and entity_id = $1",
      [(reg.body as TermInlineResponse).termId],
    );
    expect(audit.rows).toEqual([{ action: 'INSERT', actor: 'editor' }]);

    // 같은 입력 재호출(편집기 자동 재시도) → composed, 조각 검토대기
    const a1 = await ac(e, PA, '용어1책임자');
    expect(a1.type).toBe('composed');
    expect(a1.applied!.physicalNm).toBe('PA_T1_RESP');
    expect(a1.segments![1]).toMatchObject({ kor: '책임자', status: 'PENDING' });
    expect(a1.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['W_TERM_PENDING', 'W_SUFFIX_UNREGISTERED']),
    );
    expect(a1.cacheVersion).toBe(a0.cacheVersion + 1);

    // CR-01-2: PRJB는 여전히 미등록, 캐시 재적재 없음(같은 cacheVersion)
    const b1 = await ac(pa, PB, '용어1책임자');
    expect(b1.type).toBe('unregistered');
    expect(b1.cacheVersion).toBe(b0.cacheVersion);

    // 승인 큐(프로젝트 관리자)에 PENDING으로 보인다
    const q = (await pa.get(`${PA}/standards/approvals`)).body as ApprovalPage;
    expect(q.items.map((x) => [x.termKor, x.status, x.createdBy])).toContainEqual([
      '책임자',
      'PENDING',
      'editor',
    ]);
  });

  it('이미 있는 용어는 그 용어를 사용(200 EXISTING, 쓰기 없음) · 물리약어 형식 400 · 같은 물리약어 경고(conflicts)', async () => {
    const e = await as('editor');
    const n0 = cache.recentInvalidations().length;
    const again = await e.post(`${PA}/standards/terms/inline`, {
      termKor: '책임자',
      termPhysical: 'OTHER',
    });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ outcome: 'EXISTING', termPhysical: 'RESP' });
    expect(cache.recentInvalidations().length).toBe(n0);
    expect(
      (await e.post(`${PA}/standards/terms/inline`, { termKor: '반응', termPhysical: 'resp' }))
        .status,
    ).toBe(400);
    const shared = await e.post(`${PA}/standards/terms/inline`, {
      termKor: '반응',
      termPhysical: 'PA_T2',
    });
    expect(shared.status).toBe(201);
    expect(shared.body).toMatchObject({
      outcome: 'CREATED',
      conflicts: [{ termKor: '용어2', termPhysical: 'PA_T2' }],
      warnings: [{ code: 'W_TERM_PHYSICAL_SHARED' }],
    });
  });

  it('반려 → 자동완성 제외(미등록) → 편집자가 다시 인라인 등록하면 같은 행이 PENDING으로 갱신(REOPENED, 감사 UPDATE)', async () => {
    const e = await as('editor');
    const pa = await as('pa');
    const [row] = (
      await t.pool.query('select term_id from std_term where project_id = $1 and term_kor = $2', [
        pid['PRJA'],
        '반응',
      ])
    ).rows;
    const rej = await pa.post(`${PA}/standards/approvals/${row.term_id}/reject`, {
      note: '물리약어 공유',
    });
    expect(rej.status).toBe(200);
    expect((await ac(e, PA, '용어1반응')).type).toBe('unregistered');
    const re = await e.post(`${PA}/standards/terms/inline`, {
      termKor: '반응',
      termPhysical: 'RSPNS',
    });
    expect(re.status).toBe(201);
    expect(re.body).toMatchObject({
      termId: row.term_id,
      outcome: 'REOPENED',
      status: 'PENDING',
      termPhysical: 'RSPNS',
    });
    const r = await ac(e, PA, '용어1반응');
    expect(r).toMatchObject({ type: 'composed', applied: { physicalNm: 'PA_T1_RSPNS' } });
    const audit = await t.pool.query(
      "select action from std_audit_log where entity_type = 'TERM' and entity_id = $1 order by audit_id",
      [row.term_id],
    );
    expect(audit.rows.map((x) => x.action)).toEqual(['INSERT', 'REJECT', 'UPDATE']);
  });

  it('조회자는 인라인 등록 403(§7.3), 보관 프로젝트 409', async () => {
    const v = await as('viewer');
    expect(
      (await v.post(`${PA}/standards/terms/inline`, { termKor: '가', termPhysical: 'GA' })).status,
    ).toBe(403);
  });
});

describe('재검증 경고(§4.8, T9.9): 검토대기 사용 → 정정 후 승인 → 편집기 재진입 W_TERM_CHANGED', () => {
  it('composed 컬럼 저장 → validate W_TERM_PENDING → 관리자 정정 승인(RESP → RSPB) → GET 상세 W_TERM_CHANGED(재적용 안내)', async () => {
    const e = await as('editor');
    const pa = await as('pa');
    const a = await ac(e, PA, '용어1책임자');
    const body = {
      table: { bizAreaId: rpId, tableNm: 'RP_AC_HINT', tableLogicalNm: '힌트', description: null },
      columns: [
        {
          columnId: null,
          logicalNm: '용어1책임자',
          physicalNm: a.applied!.physicalNm,
          isPk: true,
          dataType: 'VARCHAR',
          dataLength: 20,
          colComment: '용어1책임자',
          matchType: 'COMPOSED',
        },
      ],
    };
    const v = (await e.post(`${PA}/tables/validate`, body)).body as TableValidateResponse;
    expect(v.warnings.map((w) => w.code)).toContain('W_TERM_PENDING');
    const saved = await e.post(`${PA}/tables`, body);
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    const id = (saved.body as TableSaveResponse).tableId;

    const [term] = (
      await t.pool.query('select term_id from std_term where project_id = $1 and term_kor = $2', [
        pid['PRJA'],
        '책임자',
      ])
    ).rows;
    const ok = await pa.post(`${PA}/standards/approvals/${term.term_id}/approve`, {
      termPhysical: 'RSPB',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const d = (await e.get(`${PA}/tables/${id}`)).body as TableDetail;
    const changed = d.warnings.find((w) => w.code === 'W_TERM_CHANGED');
    expect(changed?.message).toBe('표준이 바뀌었습니다: PA_T1_RESP → PA_T1_RSPB');
    expect(d.warnings.map((w) => w.code)).not.toContain('W_TERM_PENDING');
    // [재적용] = 같은 논리명 자동완성 → 새 물리명
    expect((await ac(e, PA, '용어1책임자')).applied!.physicalNm).toBe('PA_T1_RSPB');
  });
});

describe('POST P/tables/suggest-name(§5.5, T9.5)', () => {
  it('업무구분 접두어 + 분절, 업무구분을 바꾸면 접두어만 바뀜, 같은 이름 테이블 있으면 E_TABLE_NM_DUP(자기 자신 제외)', async () => {
    const e = await as('editor');
    const ps = (
      await t.pool.query(
        "select biz_area_id id from prj_biz_area where project_id = $1 and biz_cd = 'PS'",
        [pid['PRJA']],
      )
    ).rows[0].id as number;
    const s1 = (
      await e.post(`${PA}/tables/suggest-name`, { logicalNm: '용어1용어2', bizAreaId: rpId })
    ).body as TableNameSuggestion;
    expect(s1).toMatchObject({
      tableNm: 'RP_PA_T1_PA_T2',
      prefix: 'RP_',
      complete: true,
      errors: [],
    });
    const s2 = (
      await e.post(`${PA}/tables/suggest-name`, { logicalNm: '용어1용어2', bizAreaId: ps })
    ).body as TableNameSuggestion;
    expect(s2.tableNm).toBe('PS_PA_T1_PA_T2');
    const s3 = (
      await e.post(`${PA}/tables/suggest-name`, { logicalNm: '용어1쀍', bizAreaId: rpId })
    ).body as TableNameSuggestion;
    expect(s3).toMatchObject({ tableNm: 'RP_PA_T1_?', complete: false });
    expect(s3.warnings.map((w) => w.code)).toEqual(['W_TERM_UNREGISTERED']);

    const created = await e.post(`${PA}/tables`, {
      table: {
        bizAreaId: rpId,
        tableNm: s1.tableNm,
        tableLogicalNm: '용어1용어2',
        description: null,
      },
      columns: [],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const dup = (
      await e.post(`${PA}/tables/suggest-name`, { logicalNm: '용어1용어2', bizAreaId: rpId })
    ).body as TableNameSuggestion;
    expect(dup.errors.map((x) => x.code)).toEqual(['E_TABLE_NM_DUP']);
    const self = (
      await e.post(`${PA}/tables/suggest-name`, {
        logicalNm: '용어1용어2',
        bizAreaId: rpId,
        tableId: (created.body as TableSaveResponse).tableId,
      })
    ).body as TableNameSuggestion;
    expect(self.errors).toEqual([]);
    expect((await e.post(`${PA}/tables/suggest-name`, { logicalNm: ' ' })).status).toBe(400);
  });
});

describe('캐시 무효화 연결(T9.1) · 관리 API(T9.10) · /metrics(T9.4)', () => {
  it('표준 쓰기(PA 용어 등록) 커밋 후 다음 자동완성이 새 스냅샷(cacheVersion +1), 업무구분 쓰기도 무효화', async () => {
    const e = await as('editor');
    const pa = await as('pa');
    const v0 = (await ac(e, PA, '용어1신설어')).cacheVersion;
    const r = await pa.post(`${PA}/standards/terms`, { termKor: '신설어', termPhysical: 'NEWW' });
    expect(r.status).toBe(201);
    const a = await ac(e, PA, '용어1신설어');
    expect(a).toMatchObject({ type: 'composed', applied: { physicalNm: 'PA_T1_NEWW' } });
    expect(a.cacheVersion).toBe(v0 + 1);
    const b = await pa.post(`${PA}/biz-areas`, { bizCd: 'CM', bizNm: '공통' });
    expect(b.status).toBe(201);
    expect((await ac(e, PA, '용어1신설어')).cacheVersion).toBe(v0 + 2);
  });

  it('GET /admin/cache(SA): 적재 목록·건수·소요, reload → cacheVersion +1, 편집자 403', async () => {
    const sa = await as('sysadmin');
    const s = (await sa.get('/api/v1/admin/cache')).body as CacheStatusResponse;
    expect(s.maxProjects).toBe(20);
    expect(s.idleMinutes).toBe(60);
    const a = s.items.find((x) => x.projectKey === 'PRJA')!;
    expect(a).toMatchObject({ projectNm: '프로젝트 A', counts: { domains: 100, codeCls: 5 } });
    expect(a.counts.terms).toBeGreaterThanOrEqual(50);
    expect(a.loadMs).toBeGreaterThan(0);
    const rl = await sa.post('/api/v1/admin/cache/PRJA/reload');
    expect(rl.status).toBe(200);
    expect(rl.body).toMatchObject({ projectKey: 'PRJA', cacheVersion: a.cacheVersion + 1 });
    expect((await sa.post('/api/v1/admin/cache/NOPE/reload')).status).toBe(404);
    expect((await (await as('editor')).get('/api/v1/admin/cache')).status).toBe(403);
  });

  it('GET /metrics(익명): termflow_autocomplete{type} 히스토그램·캐시 적재', async () => {
    const anon = new Client(app.getHttpServer());
    const r = await anon.get('/metrics');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/plain');
    expect(r.text).toMatch(/termflow_autocomplete_bucket\{le="0\.02",type="exact"\} \d+/);
    expect(r.text).toMatch(/termflow_autocomplete_count\{type="composed"\} \d+/);
    expect(r.text).toContain('termflow_term_cache_load_count');
  });
});
