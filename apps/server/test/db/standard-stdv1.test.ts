import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DomainPage, DomainRecalcResponse, TermPage } from '@termflow/shared';
import { createDb, type Db } from '../../src/db/client.js';
import { Client, createTestApp, setTestEnv } from './setup/app.js';
import { createMigratedDatabase, FIXTURE_PASSWORD } from './setup/databases.js';
import { ISOLATED, perfLimit } from './setup/perf.js';
import { insertUsers, PHASE1, PHASE2, runSteps, tempReportRoot } from './setup/stdv1.js';

// 단계 6 실데이터(RETAILV1·RMS: 용어 1,705·도메인 4,587): 목록·검색 성능(§12.1 목록 20행 200ms), T6.4 DoD(RETAILV1 recalculate REVIEW_ONLY)
let pool: pg.Pool;
let db: Db;
let app: INestApplication;
const rep = tempReportRoot('tf-std-');

beforeAll(async () => {
  const url = await createMigratedDatabase('t_std_stdv1');
  pool = new pg.Pool({ connectionString: url, max: 4 });
  db = createDb(pool);
  await insertUsers(pool);
  expect((await runSteps({ pool, db, url }, rep.dir, 'p1', PHASE1)).ok).toBe(true);
  expect((await runSteps({ pool, db, url }, rep.dir, 'p2', PHASE2)).ok).toBe(true);
  setTestEnv(url);
  app = await createTestApp();
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  rep.cleanup();
});

async function sa(): Promise<Client> {
  const c = new Client(app.getHttpServer());
  expect((await c.login('sysadmin', FIXTURE_PASSWORD)).status).toBe(200);
  return c;
}

const p95 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]!;
};

describe('목록·검색 성능(§12.1 목록 20행 200ms) — RMS 실데이터', () => {
  it('용어 1,705·도메인 4,587: 첫 페이지·검색·필터·정렬 p95 200ms 이하', async () => {
    const c = await sa();
    const P = '/api/v1/projects/RMS/standards';
    const cases: [string, string][] = [
      ['용어 첫 페이지', `${P}/terms`],
      ['용어 검색(연구)', `${P}/terms?q=${encodeURIComponent('연구')}`],
      ['용어 물리약어 정렬·마지막 쪽', `${P}/terms?sort=termPhysical,desc&page=80`],
      ['용어 공유 그룹', `${P}/terms?shared=true`],
      ['도메인 첫 페이지', `${P}/domains`],
      ['도메인 검색(과제번호)', `${P}/domains?q=${encodeURIComponent('과제번호')}`],
      ['도메인 검토필요', `${P}/domains?review=true`],
      ['도메인 접미어 NO', `${P}/domains?suffix=NO`],
      ['도메인 마지막 쪽(size 100)', `${P}/domains?size=100&page=46`],
      ['도메인분류', `${P}/domain-classes?size=100`],
      ['코드구분(RP)', `${P}/code-classes?size=100`],
      ['전역 검색', `/api/v1/projects/RMS/search?q=${encodeURIComponent('과제')}`],
    ];
    const report: string[] = [];
    for (const [name, url] of cases) {
      await c.get(url); // 워밍업(계획 캐시)
      const ms: number[] = [];
      for (let i = 0; i < 20; i++) {
        const t0 = performance.now();
        const r = await c.get(url);
        ms.push(performance.now() - t0);
        expect(r.status, `${name} ${JSON.stringify(r.body).slice(0, 200)}`).toBe(200);
      }
      const v = p95(ms);
      report.push(`${name} p95 ${v.toFixed(1)}ms`);
      expect(v, name).toBeLessThan(perfLimit(200, 1500));
    }
    console.log(`[perf${ISOLATED ? '' : '(전체 실행·완화 기준)'}] ${report.join(' · ')}`);
    const terms = (await c.get(`${P}/terms`)).body as TermPage;
    expect(terms.total).toBe(1705);
    const domains = (await c.get(`${P}/domains`)).body as DomainPage;
    expect(domains.total).toBe(4587);
    expect(domains.counts.review).toBe(293);
  });
});

describe('T6.4 DoD: RETAILV1에서 recalculate REVIEW_ONLY', () => {
  it('{updated, stillReview} 반환 — 정정 전 변경 0, 미등록 조각 용어 + 접미어 분류 등록 후 검토필요 감소', async () => {
    const c = await sa();
    const P = '/api/v1/projects/RETAILV1/standards';
    const r0 = await c.post(`${P}/domains/recalculate`, { scope: 'REVIEW_ONLY' });
    expect(r0.status, JSON.stringify(r0.body).slice(0, 300)).toBe(200);
    const first = r0.body as DomainRecalcResponse;
    expect(first.target).toBe(293);
    expect(first).toHaveProperty('updated');
    expect(first).toHaveProperty('stillReview');
    // 정정 흉내: 가장 많이 나온 미등록 조각 1개를 용어로 등록 → 재계산 → 검토필요 감소
    const top = await pool.query<{ part: string; n: number }>(
      `select part, count(*)::int n from (
         select unnest(regexp_split_to_array(substring(review_note from '미등록 조각: ([^;]+)'), ', ')) part
           from std_domain d join tf_project p using (project_id)
          where p.project_key = 'RETAILV1' and d.review_yn and review_note like '%미등록 조각%') x
        group by part order by n desc limit 1`,
    );
    const part = top.rows[0]!.part;
    const add = await c.post(`${P}/terms`, { termKor: part, termPhysical: 'FIXA' });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    const cls = await c.post(`${P}/domain-classes`, {
      suffix: 'FIXA',
      clsNm: part,
      colType: 'VARCHAR',
      colLength: 20,
    });
    expect(cls.status, JSON.stringify(cls.body)).toBe(201);
    const r1 = (await c.post(`${P}/domains/recalculate`, { scope: 'REVIEW_ONLY' }))
      .body as DomainRecalcResponse;
    expect(first.updated).toBe(0); // 정정 전: 문구만 다른 행은 건드리지 않는다
    expect(r1.resolved).toBeGreaterThan(0);
    expect(r1.stillReview).toBe(first.stillReview - r1.resolved);
    console.log(
      `[recalc] RETAILV1 REVIEW_ONLY: 1회차 대상 ${first.target} · 변경 ${first.updated} · 해제 ${first.resolved} · 잔여 ${first.stillReview} (${first.elapsedMs}ms) → '${part}'(${top.rows[0]!.n}회) 등록 후 변경 ${r1.updated} · 해제 ${r1.resolved} · 잔여 ${r1.stillReview}`,
    );
    // RMS(복사본)는 영향 없음(CR-01-2)
    const rms = (await c.get('/api/v1/projects/RMS/standards/domains?review=true&size=1'))
      .body as DomainPage;
    expect(rms.total).toBe(293);
  });
});
