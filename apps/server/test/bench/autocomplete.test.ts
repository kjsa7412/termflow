import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AutocompleteResponse } from '@termflow/shared';
import { AutocompleteService } from '../../src/autocomplete/autocomplete.service.js';
import { runAutocomplete } from '../../src/autocomplete/engine.js';
import type { ProjectCtx } from '../../src/common/project-context.js';
import { TermCacheRegistry } from '../../src/autocomplete/term-cache-registry.js';
import { createDb, type Db } from '../../src/db/client.js';
import { Client, createTestApp, setTestEnv } from '../db/setup/app.js';
import { createMigratedDatabase, FIXTURE_PASSWORD } from '../db/setup/databases.js';
import { insertUsers, PHASE1, PHASE2, runSteps, tempReportRoot } from '../db/setup/stdv1.js';

/**
 * 자동완성 성능(T9.11, 설계서 §5.8·§12.1·G6). `pnpm --filter @termflow/server bench -- autocomplete`
 * 데이터: 승계 RMS(용어 1,705·도메인 4,587·코드구분 159) + 649 컬럼 논리명. 결과는 `migration/work/bench-autocomplete.json`
 * (gitignore)과 표준 오류에 쓰고, `docs/측정_결과.md`에 옮겨 적는다.
 *  - 649 논리명 순차(서비스: 캐시 + 엔진, §5.8 "캐시에 대해") < 3초 · 서버 처리(elapsedMs) p95 < 20ms
 *  - G6: HTTP 왕복(세션·CSRF·가드 포함, 실제 포트) p95 ≤ 300ms — 요청당 세션·권한 DB 왕복은 기준선(GET /me)으로 분리 보고
 *  - 캐시 첫 적재 < 300ms(분리 보고) · 인라인 등록 직후 재시도(무효화 → 재적재 포함) p95 < 300ms
 */
let pool: pg.Pool;
let db: Db;
let app: INestApplication;
let rmsId = 0;
let rpId = 0;
const P = '/api/v1/projects/RMS';
const rep = tempReportRoot('tf-bench-ac-');
const OUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../migration/work/bench-autocomplete.json',
);
const results: Record<string, unknown> = {};

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * p) - 1))]!;
};
const stat = (xs: number[]) => ({
  n: xs.length,
  p50: +pct(xs, 0.5).toFixed(1),
  p95: +pct(xs, 0.95).toFixed(1),
  max: +Math.max(...xs).toFixed(1),
  sum: +xs.reduce((a, b) => a + b, 0).toFixed(0),
});
const log = (k: string, v: unknown) => {
  results[k] = v;
  process.stderr.write(`[bench autocomplete] ${k} ${JSON.stringify(v)}\n`);
};

beforeAll(async () => {
  const url = await createMigratedDatabase('t_bench_ac');
  pool = new pg.Pool({ connectionString: url, max: 4 });
  db = createDb(pool);
  const users = await insertUsers(pool);
  expect((await runSteps({ pool, db, url }, rep.dir, 'p1', PHASE1)).ok).toBe(true);
  expect((await runSteps({ pool, db, url }, rep.dir, 'p2', PHASE2)).ok).toBe(true);
  rmsId = (await pool.query("select project_id id from tf_project where project_key = 'RMS'"))
    .rows[0].id as number;
  rpId = (
    await pool.query(
      "select biz_area_id id from prj_biz_area where project_id = $1 and biz_cd = 'RP'",
      [rmsId],
    )
  ).rows[0].id as number;
  await pool.query(
    `insert into tf_project_member (project_id, user_id, member_role, created_by, updated_by)
     values ($1, $2, 'EDITOR', 'SYSTEM', 'SYSTEM')`,
    [rmsId, users['editor']],
  );
  setTestEnv(url);
  app = await createTestApp();
  // 실제 포트로 한 번 기동해 둔다(supertest에 서버 객체를 주면 요청마다 임시 포트를 열고 닫아 측정이 부풀려진다)
  await app.listen(0, '127.0.0.1');
  const addr = app.getHttpServer().address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => {
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    `${JSON.stringify({ measuredAt: new Date().toISOString(), node: process.version, ...results }, null, 2)}\n`,
  );
  await app?.close();
  await pool?.end();
  rep.cleanup();
});

let baseUrl = '';
async function logicalNames(): Promise<string[]> {
  const { rows } = await pool.query<{ logical_nm: string }>(
    'select logical_nm from prj_column where project_id = $1 order by table_id, col_seq',
    [rmsId],
  );
  expect(rows).toHaveLength(649);
  return rows.map((r) => r.logical_nm);
}
async function editor(): Promise<Client> {
  const c = new Client(baseUrl);
  expect((await c.login('editor', FIXTURE_PASSWORD)).status).toBe(200);
  return c;
}

describe('자동완성 성능(G6)', () => {
  it('캐시 첫 적재 < 300ms(10회 재적재 p95)', async () => {
    const cache = app.get(TermCacheRegistry);
    const times: number[] = [];
    for (let i = 0; i < 10; i++) {
      cache.invalidate(rmsId);
      const r = await cache.get(rmsId);
      expect(r.loaded).toBe(true);
      times.push(r.loadMs);
    }
    const s = stat(times);
    log('cacheFirstLoadMs', { ...s, counts: (await cache.get(rmsId)).snapshot.counts });
    expect(s.p95).toBeLessThan(300);
  });

  it('649 논리명 순차(서비스 = 캐시 + 엔진 + 측정·로그, §5.8 "캐시에 대해 순차 호출") < 3초 · 서버 p95 < 20ms', async () => {
    const rows = await logicalNames();
    const svc = app.get(AutocompleteService);
    const ctx: ProjectCtx = {
      projectId: rmsId,
      projectKey: 'RMS',
      kind: 'PROJECT',
      status: 'ACTIVE',
      role: 'EDITOR',
      sysAdmin: false,
    };
    await svc.column(ctx, { logicalNm: '워밍업', excludeColumnId: null, bizAreaId: rpId });
    const each: number[] = [];
    const server: number[] = [];
    const types: Record<string, number> = {};
    const t0 = performance.now();
    for (const nm of rows) {
      const t1 = performance.now();
      const r = await svc.column(ctx, { logicalNm: nm, excludeColumnId: null, bizAreaId: rpId });
      each.push(performance.now() - t1);
      server.push(r.elapsedMs);
      types[r.type] = (types[r.type] ?? 0) + 1;
    }
    const totalMs = performance.now() - t0;
    const snap = (await app.get(TermCacheRegistry).get(rmsId)).snapshot;
    const direct: number[] = [];
    for (const nm of rows) {
      const t1 = performance.now();
      runAutocomplete(snap, nm, { bizAreaId: rpId });
      direct.push(performance.now() - t1);
    }
    log('sequential649Service', {
      totalMs: Math.round(totalMs),
      callMs: stat(each),
      serverElapsedMs: stat(server),
      engineDirectMs: stat(direct),
      types,
    });
    expect(totalMs).toBeLessThan(3000);
    expect(pct(server, 0.95)).toBeLessThan(20);
  });

  it('G6: HTTP 왕복(세션·CSRF·권한 가드 포함) 649회 p95 ≤ 300ms, 기준선(GET /me) 분리 보고', async () => {
    const rows = await logicalNames();
    const e = await editor();
    await e.post(`${P}/autocomplete/columns`, { logicalNm: '워밍업' });
    const base: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t1 = performance.now();
      expect((await e.get('/api/v1/me')).status).toBe(200);
      base.push(performance.now() - t1);
    }
    const rtt: number[] = [];
    const server: number[] = [];
    const t0 = performance.now();
    for (const nm of rows) {
      const t1 = performance.now();
      const res = await e.post(`${P}/autocomplete/columns`, { logicalNm: nm, bizAreaId: rpId });
      rtt.push(performance.now() - t1);
      server.push((res.body as AutocompleteResponse).elapsedMs);
    }
    log('http649', {
      totalMs: Math.round(performance.now() - t0),
      rttMs: stat(rtt),
      serverElapsedMs: stat(server),
      baselineGetMeMs: stat(base),
    });
    expect(pct(rtt, 0.95)).toBeLessThanOrEqual(300);
  });

  it('인라인 등록 직후 재시도(무효화 → 재적재 포함) p95 < 300ms(20회)', async () => {
    const e = await editor();
    const retry: number[] = [];
    const register: number[] = [];
    for (let i = 0; i < 20; i++) {
      const kor = `벤치어${String.fromCharCode(0xac00 + i)}`;
      const a0 = (await e.post(`${P}/autocomplete/columns`, { logicalNm: `연구${kor}구분` }))
        .body as AutocompleteResponse;
      expect(a0.type).toBe('unregistered');
      const t1 = performance.now();
      const reg = await e.post(`${P}/standards/terms/inline`, {
        termKor: kor,
        termPhysical: `BCH${i}`,
      });
      register.push(performance.now() - t1);
      expect(reg.status).toBe(201);
      const t2 = performance.now();
      const a1 = (await e.post(`${P}/autocomplete/columns`, { logicalNm: `연구${kor}구분` }))
        .body as AutocompleteResponse;
      retry.push(performance.now() - t2);
      expect(a1.applied!.physicalNm).toBe(`RSCH_BCH${i}_TP`);
    }
    log('inlineRegisterThenRetryMs', { registerMs: stat(register), retryMs: stat(retry) });
    expect(pct(retry, 0.95)).toBeLessThan(300);
  });
});
