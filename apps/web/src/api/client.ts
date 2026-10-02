import { API_PREFIX, isProblemDetail, type ProblemDetail } from '@termflow/shared';

/**
 * API 클라이언트(설계서 §2.5.6·§7.4, T4.10). fetch 래퍼:
 *  - 비-GET 요청에 `X-XSRF-TOKEN` 자동 첨부(토큰이 없으면 `GET /auth/csrf` 본문으로 먼저 받는다). CSRF 쿠키는 읽지 않는다 —
 *    서버가 인스턴스마다 쿠키 이름을 바꿀 수 있고(CR-15 C4), 같은 호스트 다른 포트 인스턴스의 쿠키를 집으면 403이 난다
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
  /** multipart/form-data(일괄 등록 업로드, §9.4). Content-Type은 브라우저가 경계값과 함께 정한다. */
  formData?: FormData;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
}

export interface ApiClientOptions {
  fetch?: typeof fetch;
  base?: string;
  onUnauthorized?: (e: ApiError) => void;
  onPasswordChangeRequired?: (e: ApiError) => void;
}

export const CSRF_HEADER = 'X-XSRF-TOKEN';

export interface ApiClient {
  request<T>(method: string, path: string, opts?: RequestOptions): Promise<T>;
  get<T>(path: string, opts?: RequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  put<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  del<T>(path: string, opts?: RequestOptions): Promise<T>;
  /** multipart 업로드(POST). */
  upload<T>(path: string, formData: FormData, opts?: RequestOptions): Promise<T>;
  /** 파일 내려받기(GET): 본문 Blob + Content-Disposition 파일명. */
  download(path: string, opts?: RequestOptions): Promise<{ blob: Blob; fileName: string | null }>;
  /** 파일 내려받기(POST 본문, DDL .sql·.zip·.tsv, §6.10). */
  downloadPost(
    path: string,
    body: unknown,
    opts?: RequestOptions,
  ): Promise<{ blob: Blob; fileName: string | null }>;
  /** 로그인 응답의 새 토큰으로 교체(세션 ID가 바뀌므로, CR-02 C6). null이면 다음 비-GET에서 다시 받는다. */
  setCsrfToken(token: string | null): void;
  configure(opts: Pick<ApiClientOptions, 'onUnauthorized' | 'onPasswordChangeRequired'>): void;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const doFetch = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = options.base ?? API_PREFIX;
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
      const token = body?.token;
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
    if (opts.formData) {
      body = opts.formData;
    } else if (opts.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(opts.form).toString();
    } else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    if (method !== 'GET' && method !== 'HEAD') {
      headers[CSRF_HEADER] = csrfToken ?? (await fetchCsrf());
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

  async function fail(res: Response, path: string): Promise<never> {
    const body = (await res.json().catch(() => null)) as unknown;
    const err = new ApiError(res.status, isProblemDetail(body) ? body : null);
    if (res.status === 401 && path !== '/auth/login') handlers.onUnauthorized?.(err);
    if (res.status === 403 && err.type === 'password-change-required') {
      handlers.onPasswordChangeRequired?.(err);
    }
    throw err;
  }

  async function download(
    path: string,
    opts: RequestOptions = {},
    method = 'GET',
  ): Promise<{ blob: Blob; fileName: string | null }> {
    const res = await send(method, path, opts, false);
    if (!res.ok) return fail(res, path);
    return { blob: await res.blob(), fileName: fileNameOf(res.headers.get('Content-Disposition')) };
  }

  async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await send(method, path, opts, false);
    if (res.ok) {
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
    return fail(res, path);
  }

  return {
    request,
    get: (p, o) => request('GET', p, o),
    post: (p, b, o) => request('POST', p, { ...o, body: b }),
    put: (p, b, o) => request('PUT', p, { ...o, body: b }),
    del: (p, o) => request('DELETE', p, o),
    upload: (p, fd, o) => request('POST', p, { ...o, formData: fd }),
    download: (p, o) => download(p, o),
    downloadPost: (p, b, o) => download(p, { ...o, body: b }, 'POST'),
    setCsrfToken(token) {
      csrfToken = token;
    },
    configure(o) {
      Object.assign(handlers, o);
    },
  };
}

/** `Content-Disposition`의 파일명(RFC 5987 `filename*=UTF-8''…` 우선). */
export function fileNameOf(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* 잘못된 인코딩이면 아래 일반 이름 */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1] ?? null;
}

/** 브라우저에서 Blob을 파일로 저장(다운로드 링크 클릭). */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 앱 전역 인스턴스. 401·강제 변경 처리기는 main.ts가 라우터와 연결한다. */
export const api = createApiClient();
