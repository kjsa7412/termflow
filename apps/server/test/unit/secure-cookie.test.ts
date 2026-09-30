import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  helmetMiddleware,
  secureCookieMode,
  sessionMiddleware,
} from '../../src/auth/http-security.js';
import type { Env } from '../../src/config/env.schema.js';

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

  it('false: HTTPS여도 Secure·HSTS 없음', async () => {
    const res = await request(app('false')).get('/').set('X-Forwarded-Proto', 'https');
    expect(sid(res)).not.toMatch(/Secure/i);
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });
});
