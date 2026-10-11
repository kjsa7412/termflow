import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import {
  bearerMiddleware,
  bearerToken,
  isTokenDeniedPath,
  TokenRateLimiter,
} from '../../src/auth/bearer.js';
import { buildUrl } from '../../src/mcp/executor.js';
import type { RouteTool } from '../../src/mcp/route-catalog.js';

// CR-18 접근 토큰 미들웨어·도구 URL(단위)

const AUTH = { tokenId: 7, userId: 3, loginId: 'editor', tokenPrefix: 'tfp_abcdefgh' };
const GOOD = `tfp_${'a'.repeat(43)}`;

function appWith(opts: { enabled: boolean; perMinute?: number; valid?: boolean }) {
  const verify = vi.fn(async () => (opts.valid === false ? null : AUTH));
  const app = express();
  app.use(
    bearerMiddleware(
      { verify },
      { enabled: opts.enabled, limiter: new TokenRateLimiter(opts.perMinute ?? 100) },
    ),
  );
  app.use((req, res) => {
    res.json({ tokenAuth: req.tokenAuth ?? null });
  });
  return { app, verify };
}

describe('bearerMiddleware', () => {
  it('헤더 없음: 그대로 통과(세션 경로), /mcp만 401', async () => {
    const { app, verify } = appWith({ enabled: true });
    expect((await request(app).get('/api/v1/me')).body).toEqual({ tokenAuth: null });
    const mcp = await request(app).post('/mcp');
    expect(mcp.status).toBe(401);
    expect(mcp.headers['www-authenticate']).toMatch(/^Bearer/);
    expect(verify).not.toHaveBeenCalled();
  });

  it('연동 꺼짐이면 토큰 요청은 401 E_TOKEN_DISABLED(확인도 하지 않음)', async () => {
    const { app, verify } = appWith({ enabled: false });
    const res = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${GOOD}`);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'E_TOKEN_DISABLED' });
    expect(verify).not.toHaveBeenCalled();
  });

  it('무효 401 · 금지 경로 403 · 통과 시 req.tokenAuth', async () => {
    expect(
      (
        await request(appWith({ enabled: true, valid: false }).app)
          .get('/api/v1/me')
          .set('Authorization', `Bearer ${GOOD}`)
      ).body,
    ).toMatchObject({ code: 'E_TOKEN_INVALID' });
    const { app } = appWith({ enabled: true });
    const denied = await request(app)
      .post('/api/v1/admin/users/3/reset-password')
      .set('Authorization', `Bearer ${GOOD}`);
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: 'E_TOKEN_NOT_ALLOWED' });
    const ok = await request(app).get('/api/v1/me').set('Authorization', `bearer ${GOOD}`);
    expect(ok.body).toEqual({ tokenAuth: AUTH });
  });

  it('분당 한도 초과 429, /mcp 요청 자체는 세지 않는다', async () => {
    const { app } = appWith({ enabled: true, perMinute: 2 });
    const h = { Authorization: `Bearer ${GOOD}` };
    for (let i = 0; i < 3; i++) expect((await request(app).post('/mcp').set(h)).status).toBe(200);
    expect((await request(app).get('/api/v1/x').set(h)).status).toBe(200);
    expect((await request(app).get('/api/v1/x').set(h)).status).toBe(200);
    const over = await request(app).get('/api/v1/x').set(h);
    expect(over.status).toBe(429);
    expect(over.body).toMatchObject({ code: 'E_TOKEN_RATE_LIMIT' });
  });
});

describe('TokenRateLimiter', () => {
  it('1분 창이 지나면 다시 센다', () => {
    let now = 0;
    const l = new TokenRateLimiter(1, () => now);
    expect(l.hit(1)).toBe(true);
    expect(l.hit(1)).toBe(false);
    expect(l.hit(2)).toBe(true);
    now = 60_000;
    expect(l.hit(1)).toBe(true);
  });
});

describe('보조 함수', () => {
  it('bearerToken·isTokenDeniedPath', () => {
    const req = (h?: string) => ({ get: () => h }) as never;
    expect(bearerToken(req(`Bearer ${GOOD}`))).toBe(GOOD);
    expect(bearerToken(req('Basic abc'))).toBeNull();
    expect(bearerToken(req())).toBeNull();
    expect(isTokenDeniedPath('/api/v1/auth/login')).toBe(true);
    expect(isTokenDeniedPath('/api/v1/me/tokens/3')).toBe(true);
    expect(isTokenDeniedPath('/api/v1/me')).toBe(false);
    expect(isTokenDeniedPath('/api/v1/admin/users/3')).toBe(false);
  });

  it('buildUrl: 경로 값 인코딩·쿼리 배열·누락 오류', () => {
    const tool = {
      path: '/api/v1/projects/:projectKey/tables/:id/ddl',
      pathParams: ['projectKey', 'id'],
    } as RouteTool;
    expect(
      buildUrl(tool, {
        projectKey: 'RMS',
        id: 12,
        query: { dialect: 'POSTGRESQL', ids: [1, 2], x: null },
      }),
    ).toBe('/api/v1/projects/RMS/tables/12/ddl?dialect=POSTGRESQL&ids=1&ids=2');
    expect(buildUrl(tool, { projectKey: 'RMS' })).toEqual({ error: 'id 값이 필요합니다' });
    expect(buildUrl(tool, { projectKey: '../x', id: 1 })).toBe(
      '/api/v1/projects/..%2Fx/tables/1/ddl',
    );
  });
});
