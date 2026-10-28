import { vi } from 'vitest';

/**
 * 테스트용 fetch 가짜(서버 없이 화면·클라이언트 검증). 경로 규칙은 `METHOD /api/v1/경로`(쿼리 제외).
 * 핸들러는 요청(메서드·헤더·본문)을 받아 `json(status, body)`로 응답한다.
 */
export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: string | undefined;
}
export type Handler = (req: FakeRequest) => Response | Promise<Response>;

export function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

export function problem(
  status: number,
  type: string,
  code: string,
  extra: Record<string, unknown> = {},
): Response {
  return json(status, {
    type: `https://termflow.local/problems/${type}`,
    title: type,
    status,
    code,
    ...extra,
  });
}

export function fakeFetch(routes: Record<string, Handler>) {
  const calls: FakeRequest[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://localhost');
    const req: FakeRequest = {
      method: (init.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      query: url.searchParams,
      headers: Object.fromEntries(
        Object.entries((init.headers as Record<string, string> | undefined) ?? {}).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body: typeof init.body === 'string' ? init.body : undefined,
    };
    calls.push(req);
    const h = routes[`${req.method} ${req.path}`];
    if (!h) return problem(404, 'not-found', 'E_NOT_FOUND');
    return h(req);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

export const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * 라우터가 `path`(또는 fullPath)에 도착할 때까지 기다린다. 제한 시간 폴링(vi.waitFor) 대신 이동 완료 이벤트를 쓴다 —
 * 병렬 실행 부하에서 1초 폴링 제한을 넘겨 불안정하게 실패하던 문제(CR-05 C1).
 */
export function untilRoute(
  router: {
    currentRoute: { value: { path: string; fullPath: string } };
    afterEach(guard: (to: { path: string; fullPath: string }) => void): () => void;
  },
  target: string,
): Promise<void> {
  const hit = (r: { path: string; fullPath: string }) => r.path === target || r.fullPath === target;
  if (hit(router.currentRoute.value)) return Promise.resolve();
  return new Promise((resolve) => {
    const off = router.afterEach((to) => {
      if (hit(to)) {
        off();
        resolve();
      }
    });
  });
}
