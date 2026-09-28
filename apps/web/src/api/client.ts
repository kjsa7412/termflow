import { API_PREFIX, isProblemDetail, type ProblemDetail } from '@termflow/shared';

/**
 * API 클라이언트(설계서 §2.5.6·§7.4, T4.10). fetch 래퍼:
 *  - 비-GET 요청에 `X-XSRF-TOKEN` 자동 첨부(토큰이 없으면 `GET /auth/csrf`로 먼저 받는다)
 *  - 403 `type=…/csrf`면 토큰을 다시 받아 **1회만** 재시도
 *  - 오류 본문(ProblemDetail, RFC 9457)을 `ApiError.problem`으로 파싱
 *  - 401(로그인 요청 제외) → `onUnauthorized`, 403 password-change-required → `onPasswordChangeRequired`
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: ProblemDetail | null,
  ) {
    super(problem?.detail ?? problem?.title ?? `HTTP ${status}`);
    this.name = 'ApiError';
  }

  get code(): string | undefined {
    return this.problem?.code;
  }

  /** ProblemDetail type의 마지막 조각(`csrf`, `locked` …). */
  get type(): string | undefined {
    return this.problem?.type.split('/').pop();
  }
}

export interface RequestOptions {
  body?: unknown;
  /** application/x-www-form-urlencoded(로그인, §7.1). */
  form?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
}

export interface ApiClientOptions {
  fetch?: typeof fetch;
  base?: string;
  onUnauthorized?: (e: ApiError) => void;
  onPasswordChangeRequired?: (e: ApiError) => void;
  /** 쿠키 읽기(테스트 주입용). 기본 document.cookie. */
  readCookie?: (name: string) => string | undefined;
}

export const CSRF_HEADER = 'X-XSRF-TOKEN';
const CSRF_COOKIE = 'XSRF-TOKEN';

function documentCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const hit = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : undefined;
}

export interface ApiClient {
  request<T>(method: string, path: string, opts?: RequestOptions): Promise<T>;
  get<T>(path: string, opts?: RequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  put<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  del<T>(path: string, opts?: RequestOptions): Promise<T>;
  /** 로그인 응답의 새 토큰으로 교체(세션 ID가 바뀌므로, CR-02 C6). null이면 다음 비-GET에서 다시 받는다. */
  setCsrfToken(token: string | null): void;
  configure(opts: Pick<ApiClientOptions, 'onUnauthorized' | 'onPasswordChangeRequired'>): void;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const doFetch = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = options.base ?? API_PREFIX;
  const readCookie = options.readCookie ?? documentCookie;
  const handlers = { ...options };
  let csrfToken: string | null = null;
  let csrfPending: Promise<string> | null = null;

  async function fetchCsrf(): Promise<string> {
    csrfPending ??= (async () => {
      const res = await doFetch(`${base}/auth/csrf`, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      const body = (await res.json().catch(() => null)) as { token?: string } | null;
      const token = body?.token ?? readCookie(CSRF_COOKIE);
      if (!res.ok || !token) throw new ApiError(res.status, isProblemDetail(body) ? body : null);
      csrfToken = token;
      return token;
    })().finally(() => {
      csrfPending = null;
    });
    return csrfPending;
  }

  function url(path: string, query?: RequestOptions['query']): string {
    const u = `${base}${path}`;
    if (!query) return u;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
    }
    const s = params.toString();
    return s ? `${u}?${s}` : u;
  }

  async function send(
    method: string,
    path: string,
    opts: RequestOptions,
    retried: boolean,
  ): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    let body: BodyInit | undefined;
    if (opts.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(opts.form).toString();
    } else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    if (method !== 'GET' && method !== 'HEAD') {
      headers[CSRF_HEADER] = csrfToken ?? readCookie(CSRF_COOKIE) ?? (await fetchCsrf());
    }
    const res = await doFetch(url(path, opts.query), {
      method,
      headers,
      body,
      credentials: 'same-origin',
      signal: opts.signal,
    });
    if (res.status === 403 && !retried) {
      const problem = (await res
        .clone()
        .json()
        .catch(() => null)) as unknown;
      if (isProblemDetail(problem) && problem.type.endsWith('/csrf')) {
        csrfToken = null;
        await fetchCsrf();
        return send(method, path, opts, true);
      }
    }
    return res;
  }

  async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await send(method, path, opts, false);
    if (res.ok) {
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
    const body = (await res.json().catch(() => null)) as unknown;
    const err = new ApiError(res.status, isProblemDetail(body) ? body : null);
    if (res.status === 401 && path !== '/auth/login') handlers.onUnauthorized?.(err);
    if (res.status === 403 && err.type === 'password-change-required') {
      handlers.onPasswordChangeRequired?.(err);
    }
    throw err;
  }

  return {
    request,
    get: (p, o) => request('GET', p, o),
    post: (p, b, o) => request('POST', p, { ...o, body: b }),
    put: (p, b, o) => request('PUT', p, { ...o, body: b }),
    del: (p, o) => request('DELETE', p, o),
    setCsrfToken(token) {
      csrfToken = token;
    },
    configure(o) {
      Object.assign(handlers, o);
    },
  };
}

/** 앱 전역 인스턴스. 401·강제 변경 처리기는 main.ts가 라우터와 연결한다. */
export const api = createApiClient();
