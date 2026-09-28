import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/db/migrate.js';
import { createDatabase } from '../setup/databases.js';
import {
  CookieJar,
  createPocApp,
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
  seedPoc,
  type PocApp,
} from './app/poc-app.js';

// T1.5 세션 로그인: express-session + connect-pg-simple(tf_session) + csrf-csrf + bcrypt
const SECRET = 'poc-session-secret-0123456789abcdef-0123';

describe('poc/session (T1.5)', () => {
  let pool: pg.Pool;
  let a: PocApp;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createDatabase('poc_session') });
    await runMigrations(pool);
    await seedPoc(pool);
    a = await createPocApp(pool, SECRET);
  });
  afterAll(async () => {
    await a.close();
    await pool.end();
  });

  const sessionRows = async () =>
    Number((await pool.query<{ n: string }>('select count(*) n from tf_session')).rows[0]?.n);

  it('CSRF 헤더 없는 로그인은 403', async () => {
    const res = await request(a.app.getHttpServer())
      .post('/api/v1/auth/login')
      .type('form')
      .send({ loginId: 'hong', password: 'Passw0rd!' });
    expect(res.status).toBe(403);
  });

  it('csrf → login → /me 200 → 서버 재생성 후에도 세션 유지 → logout → 401', async () => {
    const jar = new CookieJar();
    let server = a.app.getHttpServer();

    const c = await request(server).get('/api/v1/auth/csrf').expect(200);
    jar.store(c.headers['set-cookie']);
    const preToken = (c.body as { token: string }).token;
    expect(jar.get(CSRF_COOKIE)).toBe(preToken);
    expect(jar.get(SESSION_COOKIE)).toBeDefined();

    // 잘못된 비밀번호 → 401
    await request(server)
      .post('/api/v1/auth/login')
      .set('Cookie', jar.header())
      .set(CSRF_HEADER, preToken)
      .type('form')
      .send({ loginId: 'hong', password: 'wrong' })
      .expect(401);

    const login = await request(server)
      .post('/api/v1/auth/login')
      .set('Cookie', jar.header())
      .set(CSRF_HEADER, preToken)
      .type('form')
      .send({ loginId: 'hong', password: 'Passw0rd!' })
      .expect(200);
    const preSid = jar.get(SESSION_COOKIE);
    jar.store(login.headers['set-cookie']);
    const body = login.body as {
      user: { loginId: string };
      mustChangePassword: boolean;
      csrfToken: string;
    };
    expect(body.user.loginId).toBe('hong');
    expect(body.mustChangePassword).toBe(false);
    expect(jar.get(SESSION_COOKIE)).not.toBe(preSid); // regenerate → 세션 ID 재발급
    expect(jar.get(CSRF_COOKIE)).toBe(body.csrfToken);
    expect(await sessionRows()).toBe(1); // 익명 세션은 regenerate가 저장소에서 지운다

    await request(server).get('/api/v1/me').set('Cookie', jar.header()).expect(200);

    // 로그인 전 토큰은 새 세션 ID에 바인딩되지 않으므로 거부된다
    const stale = await request(server)
      .post('/api/v1/auth/logout')
      .set('Cookie', jar.header().replace(body.csrfToken, preToken))
      .set(CSRF_HEADER, preToken);
    expect(stale.status).toBe(403);

    // 서버 재생성(같은 DB·같은 비밀키) — 세션은 tf_session에서 복원된다
    await a.close();
    a = await createPocApp(pool, SECRET);
    server = a.app.getHttpServer();
    const me = await request(server).get('/api/v1/me').set('Cookie', jar.header()).expect(200);
    expect((me.body as { loginId: string }).loginId).toBe('hong');

    const out = await request(server)
      .post('/api/v1/auth/logout')
      .set('Cookie', jar.header())
      .set(CSRF_HEADER, body.csrfToken)
      .expect(204);
    jar.store(out.headers['set-cookie']);
    expect(await sessionRows()).toBe(0);
    await request(server).get('/api/v1/me').set('Cookie', jar.header()).expect(401);
  });
});
