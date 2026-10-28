import cookieParser from 'cookie-parser';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  cookieNames,
  createCsrf,
  helmetMiddleware,
  secureCookieMode,
  sessionMiddleware,
} from '../../src/auth/http-security.js';
import { parseEnv, type Env } from '../../src/config/env.schema.js';

// CR-11a C5: production 컨테이너를 http://localhost:8080으로 직접 열어도(start.ps1) 로그인 세션 쿠키가 발급돼야 한다.
type Mode = Env['TERMFLOW_SECURE_COOKIE'];

function app(mode: Mode | undefined) {
  const e = express();
  e.set('trust proxy', 1);
  const env = {
    NODE_ENV: 'production' as const,
    TERMFLOW_SESSION_SECRET: 'x'.repeat(40),
    TERMFLOW_SESSION_TIMEOUT: '60m',
    ...(mode ? { TERMFLOW_SECURE_COOKIE: mode } : {}),
  };
  e.use(helmetMiddleware(env));
  e.use(sessionMiddleware(env, new session.MemoryStore()));
  e.get('/', (req, res) => {
    req.session.anon = true;
    res.send('ok');
  });
  return e;
}

function sid(res: request.Response): string | undefined {
  const cookies = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  return cookies.find((c) => c.startsWith('tf.sid='));
}

describe('TERMFLOW_SECURE_COOKIE(CR-11a C5)', () => {
  it('dev·test는 항상 false, production 기본은 auto', () => {
    expect(secureCookieMode({ NODE_ENV: 'development', TERMFLOW_SECURE_COOKIE: 'true' })).toBe(
      false,
    );
    expect(secureCookieMode({ NODE_ENV: 'production' })).toBe('auto');
    expect(secureCookieMode({ NODE_ENV: 'production', TERMFLOW_SECURE_COOKIE: 'true' })).toBe(true);
    expect(secureCookieMode({ NODE_ENV: 'production', TERMFLOW_SECURE_COOKIE: 'false' })).toBe(
      false,
    );
  });

  it('auto: HTTP 직접 접속이면 Secure 없이 발급, upgrade-insecure-requests 없음', async () => {
    const res = await request(app('auto')).get('/');
    expect(sid(res)).toBeDefined();
    expect(sid(res)).not.toMatch(/Secure/i);
    expect(res.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
  });

  it('auto: 프록시 X-Forwarded-Proto: https면 Secure', async () => {
    const res = await request(app(undefined)).get('/').set('X-Forwarded-Proto', 'https');
    expect(sid(res)).toMatch(/; Secure/);
  });

  it('true: HTTP에서는 세션 쿠키를 내지 않고(express-session), CSP에 upgrade-insecure-requests', async () => {
    const http = await request(app('true')).get('/');
    expect(sid(http)).toBeUndefined();
    expect(http.headers['content-security-policy']).toContain('upgrade-insecure-requests');
    const https = await request(app('true')).get('/').set('X-Forwarded-Proto', 'https');
    expect(sid(https)).toMatch(/; Secure/);
  });

  it('COOP: HTTP(사내 PC 이름·IP)에서는 보내지 않고 HTTPS·localhost에서만(콘솔 오류 방지, CR-15 C17)', async () => {
    const http = await request(app('auto')).get('/').set('Host', '192.168.0.10:7340');
    expect(http.headers['cross-origin-opener-policy']).toBeUndefined();
    const https = await request(app('auto'))
      .get('/')
      .set('Host', '192.168.0.10:7340')
      .set('X-Forwarded-Proto', 'https');
    expect(https.headers['cross-origin-opener-policy']).toBe('same-origin');
    const local = await request(app('auto')).get('/').set('Host', 'localhost:7340');
    expect(local.headers['cross-origin-opener-policy']).toBe('same-origin');
  });

  it('false: HTTPS여도 Secure·HSTS 없음', async () => {
    const res = await request(app('false')).get('/').set('X-Forwarded-Proto', 'https');
    expect(sid(res)).not.toMatch(/Secure/i);
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });
});

// CR-15 C4: 같은 호스트의 두 인스턴스(포트만 다름)는 쿠키를 공유하므로 이름을 나눈다
describe('쿠키 이름 접미어(CR-15 C4)', () => {
  it('접미어 → TERMFLOW_COOKIE_SUFFIX, 없으면 TERMFLOW_APP_PORT, 둘 다 없으면 기존 이름', () => {
    expect(cookieNames({})).toEqual({ session: 'tf.sid', csrf: 'XSRF-TOKEN' });
    expect(cookieNames({ TERMFLOW_APP_PORT: 7350 })).toEqual({
      session: 'tf.sid.7350',
      csrf: 'XSRF-TOKEN-7350',
    });
    expect(cookieNames({ TERMFLOW_APP_PORT: 7350, TERMFLOW_COOKIE_SUFFIX: 'rehearsal' })).toEqual({
      session: 'tf.sid.rehearsal',
      csrf: 'XSRF-TOKEN-rehearsal',
    });
  });

  it('env 형식: 접미어는 영문·숫자·_·- 1~32자, 포트는 숫자', () => {
    const base = { TERMFLOW_DB_URL: 'postgres://h:5432/termflow', TERMFLOW_DB_PASSWORD: 'p' };
    const ok = parseEnv({ ...base, TERMFLOW_COOKIE_SUFFIX: 'tf-2', TERMFLOW_APP_PORT: '7350' });
    expect(ok.ok && ok.env.TERMFLOW_COOKIE_SUFFIX).toBe('tf-2');
    expect(ok.ok && ok.env.TERMFLOW_APP_PORT).toBe(7350);
    const bad = parseEnv({ ...base, TERMFLOW_COOKIE_SUFFIX: 'a b' });
    expect(bad.ok).toBe(false);
  });

  it('세션·CSRF 쿠키가 접미어 이름으로 발급된다', async () => {
    const env = {
      NODE_ENV: 'production' as const,
      TERMFLOW_SESSION_SECRET: 'x'.repeat(40),
      TERMFLOW_SESSION_TIMEOUT: '60m',
      TERMFLOW_APP_PORT: 7350,
    };
    const e = express();
    e.use(cookieParser());
    e.use(sessionMiddleware(env, new session.MemoryStore()));
    const csrf = createCsrf(env);
    e.get('/', (req, res) => {
      req.session.anon = true;
      res.json({ token: csrf.generateCsrfToken(req, res) });
    });
    const res = await request(e).get('/');
    const cookies = (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split('=')[0]);
    expect(cookies).toEqual(expect.arrayContaining(['tf.sid.7350', 'XSRF-TOKEN-7350']));
    expect(cookies).not.toContain('tf.sid');
  });
});
