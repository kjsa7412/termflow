import type { RouteTool } from './route-catalog.js';

/** 도구 결과 텍스트 상한(문자). 넘으면 잘라 내고 알린다 — 목록은 query의 page·size로 나눠 받는다. */
export const RESULT_MAX_CHARS = 100_000;
const CALL_TIMEOUT_MS = 60_000;

export interface CallContext {
  /** 같은 서버의 루프백 주소(`http://127.0.0.1:<포트>`). */
  baseUrl: string;
  /** 들어온 요청의 Authorization 헤더 그대로(같은 토큰·같은 권한으로 REST를 부른다). */
  authorization: string;
  /** 감사 IP 보존용(trust proxy 1). */
  forwardedFor: string | null;
}

export interface ToolResult {
  [k: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function text(t: string, isError = false): ToolResult {
  const body =
    t.length > RESULT_MAX_CHARS
      ? `${t.slice(0, RESULT_MAX_CHARS)}\n…(결과가 ${t.length}자라 ${RESULT_MAX_CHARS}자에서 잘랐다. query의 page·size·필터로 나눠 받을 것)`
      : t;
  return { content: [{ type: 'text', text: body }], ...(isError ? { isError: true } : {}) };
}

function appendQuery(sp: URLSearchParams, k: string, v: unknown): void {
  if (v === undefined || v === null) return;
  if (Array.isArray(v)) for (const x of v) appendQuery(sp, k, x);
  else if (typeof v === 'object') sp.append(k, JSON.stringify(v));
  else sp.append(k, String(v as string | number | boolean));
}

/** 도구 인자 → REST 요청 URL. 경로 값이 빠졌으면 오류 메시지. */
export function buildUrl(
  tool: RouteTool,
  args: Record<string, unknown>,
): string | { error: string } {
  let path = tool.path;
  for (const p of tool.pathParams) {
    const v = args[p];
    if (v === undefined || v === null || v === '') return { error: `${p} 값이 필요합니다` };
    path = path.replace(`:${p}`, encodeURIComponent(String(v as string | number)));
  }
  const sp = new URLSearchParams();
  const q = args['query'];
  if (q && typeof q === 'object') for (const [k, v] of Object.entries(q)) appendQuery(sp, k, v);
  const qs = sp.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * 도구 호출 = 같은 서버 REST 호출(CR-18 C5). 인증·권한·검증·감사·캐시가 웹 화면과 완전히 같은 경로를 탄다.
 * 오류 응답(ProblemDetail)은 isError 결과로 돌려 에이전트가 고쳐 다시 부를 수 있게 한다.
 */
export async function callRoute(
  tool: RouteTool,
  args: Record<string, unknown>,
  ctx: CallContext,
): Promise<ToolResult> {
  const url = buildUrl(tool, args);
  if (typeof url !== 'string') return text(url.error, true);
  const headers: Record<string, string> = {
    authorization: ctx.authorization,
    accept: 'application/json, text/plain;q=0.9',
  };
  if (ctx.forwardedFor) headers['x-forwarded-for'] = ctx.forwardedFor;
  const hasBody = tool.method !== 'GET' && args['body'] !== undefined;
  if (hasBody) headers['content-type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(ctx.baseUrl + url, {
      method: tool.method,
      headers,
      body: hasBody ? JSON.stringify(args['body']) : undefined,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (e) {
    return text(`요청 실패: ${e instanceof Error ? e.message : String(e)}`, true);
  }
  const type = res.headers.get('content-type') ?? '';
  const failed = res.status >= 400;
  if (res.status === 204) return text(`완료(${tool.method} ${url} → 204)`);
  if (/json/i.test(type)) {
    const raw = await res.text();
    let out = raw;
    try {
      out = JSON.stringify(JSON.parse(raw));
    } catch {
      // 그대로
    }
    return text(failed ? `HTTP ${res.status} ${out}` : out, failed);
  }
  if (/^text\//i.test(type)) {
    const body = await res.text();
    const t = body.charCodeAt(0) === 0xfeff ? body.slice(1) : body; // TSV 내려받기 BOM 제거
    return text(failed ? `HTTP ${res.status} ${t}` : t, failed);
  }
  await res.body?.cancel();
  return text(
    `파일 응답(${type || '형식 없음'}, HTTP ${res.status})은 도구로 받을 수 없다. JSON·텍스트 출력 옵션을 쓸 것`,
    true,
  );
}
