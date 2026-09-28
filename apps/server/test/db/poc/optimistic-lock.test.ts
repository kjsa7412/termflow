import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/db/migrate.js';
import { createDatabase } from '../setup/databases.js';
import { CookieJar, createPocApp, CSRF_HEADER, seedPoc, type PocApp } from './app/poc-app.js';

// T1.6 낙관적 잠금 409(§8.1) + col_seq 교환이 DEFERRABLE 유니크로 한 트랜잭션에서 성공(§8.2)
const SECRET = 'poc-lock-secret-0123456789abcdef-012345';

async function login(a: PocApp, loginId: string): Promise<{ jar: CookieJar; token: string }> {
  const server = a.app.getHttpServer();
  const jar = new CookieJar();
  const c = await request(server).get('/api/v1/auth/csrf').expect(200);
  jar.store(c.headers['set-cookie']);
  const res = await request(server)
    .post('/api/v1/auth/login')
    .set('Cookie', jar.header())
    .set(CSRF_HEADER, (c.body as { token: string }).token)
    .type('form')
    .send({ loginId, password: 'Passw0rd!' })
    .expect(200);
  jar.store(res.headers['set-cookie']);
  return { jar, token: (res.body as { csrfToken: string }).csrfToken };
}

describe('poc/optimistic-lock (T1.6)', () => {
  let pool: pg.Pool;
  let a: PocApp;
  let tableId: number;
  let columnIds: number[];

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createDatabase('poc_lock') });
    await runMigrations(pool);
    ({ tableId, columnIds } = await seedPoc(pool));
    a = await createPocApp(pool, SECRET);
  });
  afterAll(async () => {
    await a.close();
    await pool.end();
  });

  const put = (s: { jar: CookieJar; token: string }, body: unknown) =>
    request(a.app.getHttpServer())
      .put(`/api/v1/projects/RMS/tables/${tableId}`)
      .set('Cookie', s.jar.header())
      .set(CSRF_HEADER, s.token)
      .send(body as object);

  it('A·B가 같은 version으로 저장 → A 200(version 2), B 409 E_VERSION_CONFLICT', async () => {
    const A = await login(a, 'kim');
    const B = await login(a, 'hong');
    const cols = columnIds.map((id) => ({ columnId: id, logicalNm: '', physicalNm: '' }));

    const ra = await put(A, {
      version: 1,
      table: { tableLogicalNm: '연구과제마스터(A)' },
      columns: cols,
    });
    expect(ra.status).toBe(200);
    expect(ra.body).toEqual({ version: 2 });

    const rb = await put(B, {
      version: 1,
      table: { tableLogicalNm: '연구과제마스터(B)' },
      columns: cols,
    });
    expect(rb.status).toBe(409);
    const p = rb.body as Record<string, unknown> & {
      current: { table: { tableLogicalNm: string }; columns: unknown[] };
    };
    expect(p).toMatchObject({
      type: 'https://termflow.sjinc.co.kr/problems/version-conflict',
      title: '저장 충돌',
      status: 409,
      code: 'E_VERSION_CONFLICT',
      yourVersion: 1,
      currentVersion: 2,
      savedBy: '김민수',
    });
    expect(String(p['detail'])).toMatch(/^김민수이\(가\) \d{2}:\d{2}:\d{2}에 저장했습니다\.$/);
    expect(String(p['savedAt'])).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    expect(p.current.table.tableLogicalNm).toBe('연구과제마스터(A)'); // B 변경은 롤백
    expect(p.current.columns).toHaveLength(3);
  });

  it('컬럼 순서 교환(1↔2)이 한 트랜잭션에서 성공(DEFERRABLE 유니크)', async () => {
    const A = await login(a, 'kim');
    const [c1, c2, c3] = columnIds as [number, number, number];
    const res = await put(A, {
      version: 2,
      table: { tableLogicalNm: '연구과제마스터' },
      columns: [c2, c1, c3].map((id) => ({ columnId: id, logicalNm: '', physicalNm: '' })),
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: 3 });
    const { rows } = await pool.query<{ column_id: number }>(
      'select column_id from prj_column where table_id=$1 order by col_seq',
      [tableId],
    );
    expect(rows.map((r) => r.column_id)).toEqual([c2, c1, c3]);
  });

  it('대조: 제약을 IMMEDIATE로 바꾸면 같은 교환이 중간 문장에서 유니크 위반', async () => {
    const [c1, c2] = columnIds as [number, number];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET CONSTRAINTS uk_prj_column_seq IMMEDIATE');
      await expect(
        client.query('update prj_column set col_seq = 2 where column_id = $1', [c2]),
      ).rejects.toThrow(/uk_prj_column_seq/);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(c1).toBeGreaterThan(0);
  });
});
