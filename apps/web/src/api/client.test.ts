import { describe, expect, it, vi } from 'vitest';
import { fakeFetch, json, problem } from '../test-utils.js';
import { ApiError, createApiClient } from './client.js';

// T4.10 api/client.ts: CSRF 헤더 자동 첨부 · 403 csrf 1회 재발급 재시도 · ProblemDetail 파싱 · 401/강제 변경 처리기
describe('api/client', () => {
  it('GET은 CSRF 없이, 비-GET은 /auth/csrf로 토큰을 받아 X-XSRF-TOKEN 첨부(토큰은 재사용)', async () => {
    const f = fakeFetch({
      'GET /api/v1/auth/csrf': () => json(200, { token: 'T1' }),
      'GET /api/v1/me': () => json(200, { ok: 1 }),
      'PUT /api/v1/me/password': () => new Response(null, { status: 204 }),
    });
    const c = createApiClient({ fetch: f.fetch });
    expect(await c.get('/me')).toEqual({ ok: 1 });
    expect(f.calls[0]!.headers['x-xsrf-token']).toBeUndefined();
    expect(await c.put('/me/password', { a: 1 })).toBeUndefined();
    await c.put('/me/password', { a: 2 });
    const puts = f.calls.filter((r) => r.method === 'PUT');
    expect(puts.map((r) => r.headers['x-xsrf-token'])).toEqual(['T1', 'T1']);
    expect(f.calls.filter((r) => r.path === '/api/v1/auth/csrf')).toHaveLength(1);
    expect(puts[0]!.headers['content-type']).toBe('application/json');
    expect(puts[0]!.body).toBe('{"a":1}');
  });

  it('XSRF-TOKEN 쿠키(같은 호스트 다른 포트 인스턴스 것일 수 있음)는 읽지 않고 /auth/csrf 본문 토큰을 쓴다(CR-15 C4)', async () => {
    document.cookie = 'XSRF-TOKEN=other-instance';
    const f = fakeFetch({
      'GET /api/v1/auth/csrf': () => json(200, { token: 'MINE' }),
      'POST /api/v1/auth/logout': () => new Response(null, { status: 204 }),
    });
    const c = createApiClient({ fetch: f.fetch });
    await c.post('/auth/logout');
    expect(f.calls.find((r) => r.method === 'POST')!.headers['x-xsrf-token']).toBe('MINE');
    document.cookie = 'XSRF-TOKEN=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  });

  it('403 csrf → 토큰 재발급 후 1회만 재시도(두 번째도 실패하면 오류)', async () => {
    let tokens = 0;
    let posts = 0;
    const f = fakeFetch({
      'GET /api/v1/auth/csrf': () => json(200, { token: `T${++tokens}` }),
      'POST /api/v1/auth/logout': (r) =>
        ++posts === 1 || r.headers['x-xsrf-token'] === 'bad'
          ? problem(403, 'csrf', 'E_CSRF')
          : new Response(null, { status: 204 }),
    });
    const c = createApiClient({ fetch: f.fetch });
    c.setCsrfToken('stale');
    await expect(c.post('/auth/logout')).resolves.toBeUndefined();
    expect(
      f.calls.filter((r) => r.method === 'POST').map((r) => r.headers['x-xsrf-token']),
    ).toEqual(['stale', 'T1']);

    const always = fakeFetch({
      'GET /api/v1/auth/csrf': () => json(200, { token: 'bad' }),
      'POST /api/v1/x': () => problem(403, 'csrf', 'E_CSRF'),
    });
    const c2 = createApiClient({ fetch: always.fetch });
    await expect(c2.post('/x')).rejects.toMatchObject({ status: 403, code: 'E_CSRF' });
    expect(always.calls.filter((r) => r.method === 'POST')).toHaveLength(2);
  });

  it('오류 본문을 ProblemDetail로 파싱(ApiError.problem·code·type), form 인코딩 로그인', async () => {
    const f = fakeFetch({
      'GET /api/v1/auth/csrf': () => json(200, { token: 'T' }),
      'POST /api/v1/auth/login': (r) => {
        expect(r.headers['content-type']).toBe('application/x-www-form-urlencoded');
        expect(r.body).toBe('loginId=kim&password=p%26w');
        return problem(423, 'locked', 'E_LOCKED', { detail: '15분 후', remainingMinutes: 15 });
      },
    });
    const c = createApiClient({ fetch: f.fetch });
    const err = await c
      .request('POST', '/auth/login', { form: { loginId: 'kim', password: 'p&w' } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const e = err as ApiError;
    expect([e.status, e.code, e.type, e.message, e.problem?.['remainingMinutes']]).toEqual([
      423,
      'E_LOCKED',
      'locked',
      '15분 후',
      15,
    ]);
  });

  it('401 → onUnauthorized(로그인 요청 제외), 403 password-change-required → onPasswordChangeRequired', async () => {
    const onUnauthorized = vi.fn();
    const onPasswordChangeRequired = vi.fn();
    const f = fakeFetch({
      'GET /api/v1/auth/csrf': () => json(200, { token: 'T' }),
      'GET /api/v1/me': () => problem(401, 'unauthorized', 'E_UNAUTHORIZED'),
      'POST /api/v1/auth/login': () => problem(401, 'unauthorized', 'E_INVALID_CREDENTIALS'),
      'GET /api/v1/admin/users': () =>
        problem(403, 'password-change-required', 'E_PASSWORD_CHANGE_REQUIRED'),
    });
    const c = createApiClient({
      fetch: f.fetch,
      onUnauthorized,
      onPasswordChangeRequired,
    });
    await expect(c.get('/me')).rejects.toBeInstanceOf(ApiError);
    await expect(
      c.request('POST', '/auth/login', { form: { loginId: 'a', password: 'b' } }),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(c.get('/admin/users')).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(onPasswordChangeRequired).toHaveBeenCalledTimes(1);
  });

  it('쿼리 문자열: 빈 값·undefined 제외', async () => {
    const f = fakeFetch({ 'GET /api/v1/admin/users': (r) => json(200, { q: r.query.toString() }) });
    const c = createApiClient({ fetch: f.fetch });
    expect(
      await c.get('/admin/users', { query: { q: '김', status: undefined, page: 2, empty: '' } }),
    ).toEqual({
      q: 'q=%EA%B9%80&page=2',
    });
  });
});
