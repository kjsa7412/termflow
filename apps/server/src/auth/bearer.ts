import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { API_ERROR_CODES, API_PREFIX } from '@termflow/shared';
import { clientIp } from '../common/audit/audit.js';
import { ProblemException } from '../common/problem/problem.exception.js';
import type { ApiTokenService, TokenAuth } from './api-token.service.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Bearer 접근 토큰으로 인증된 요청(CR-18). 있으면 세션·CSRF를 쓰지 않는다. */
    tokenAuth?: TokenAuth;
  }
}

/**
 * 접근 토큰으로 부를 수 없는 경로(CR-18 C4): 로그인·로그아웃·CSRF, 비밀번호 변경, 토큰 발급·폐기(토큰이 토큰을 만들지 못하게),
 * 비밀번호 초기화(임시 비밀번호가 응답으로 나간다). 사람이 웹에서 직접 한다.
 */
const TOKEN_DENIED: RegExp[] = [
  new RegExp(`^${API_PREFIX}/auth(/|$)`),
  new RegExp(`^${API_PREFIX}/me/password$`),
  new RegExp(`^${API_PREFIX}/me/tokens(/|$)`),
  new RegExp(`^${API_PREFIX}/admin/users/[^/]+/reset-password$`),
];

const MCP_PATH_RE = /^\/mcp\/?$/;

export function isTokenDeniedPath(path: string): boolean {
  return TOKEN_DENIED.some((re) => re.test(path));
}

type TokenCode =
  'E_TOKEN_DISABLED' | 'E_TOKEN_INVALID' | 'E_TOKEN_NOT_ALLOWED' | 'E_TOKEN_RATE_LIMIT';

function tokenProblem(
  type: 'unauthorized' | 'forbidden' | 'too-many-requests',
  status: number,
  code: TokenCode,
): ProblemException {
  return new ProblemException(type, status, code, API_ERROR_CODES[code]);
}

/** 토큰별 분 단위 고정 창 카운터(단일 프로세스 전제, §2.8). */
export class TokenRateLimiter {
  private readonly windows = new Map<number, { start: number; count: number }>();

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** 허용이면 true. */
  hit(tokenId: number): boolean {
    const t = this.now();
    const w = this.windows.get(tokenId);
    if (!w || t - w.start >= 60_000) {
      this.windows.set(tokenId, { start: t, count: 1 });
      if (this.windows.size > 10_000) this.sweep(t);
      return true;
    }
    w.count += 1;
    return w.count <= this.perMinute;
  }

  private sweep(t: number): void {
    for (const [k, w] of this.windows) if (t - w.start >= 60_000) this.windows.delete(k);
  }
}

function send(req: Request, res: Response, p: ProblemException): void {
  if (p.getStatus() === 401) res.setHeader('WWW-Authenticate', 'Bearer realm="termflow"');
  res.status(p.getStatus()).type('application/problem+json').json(p.toProblem(req.originalUrl));
}

export function bearerToken(req: Request): string | null {
  const h = req.get('authorization');
  if (!h) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1]! : null;
}

/**
 * `Authorization: Bearer tfp_…` 처리(CR-18 C3). 헤더가 없으면 아무것도 하지 않는다(세션 경로).
 * 있으면: 연동 꺼짐 401 · 토큰 무효 401 · 금지 경로 403 · 한도 초과 429 → 통과 시 `req.tokenAuth`.
 * 세션·CSRF 미들웨어는 `req.tokenAuth`가 있으면 건너뛴다(쿠키를 쓰지 않으니 CSRF 대상이 아니다).
 */
export function bearerMiddleware(
  tokens: Pick<ApiTokenService, 'verify'>,
  opts: { enabled: boolean; limiter: TokenRateLimiter },
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const raw = bearerToken(req);
    if (raw === null) {
      // `/mcp`는 토큰 전용 — 세션·CSRF 단계로 넘기지 않고 401(클라이언트가 인증 방식을 알 수 있게 WWW-Authenticate).
      if (MCP_PATH_RE.test(req.path))
        send(req, res, tokenProblem('unauthorized', 401, 'E_TOKEN_INVALID'));
      else next();
      return;
    }
    if (!opts.enabled) {
      send(req, res, tokenProblem('unauthorized', 401, 'E_TOKEN_DISABLED'));
      return;
    }
    tokens.verify(raw, clientIp(req)).then(
      (auth) => {
        if (!auth) {
          send(req, res, tokenProblem('unauthorized', 401, 'E_TOKEN_INVALID'));
          return;
        }
        if (isTokenDeniedPath(req.path)) {
          send(req, res, tokenProblem('forbidden', 403, 'E_TOKEN_NOT_ALLOWED'));
          return;
        }
        // `/mcp` 요청 자체는 세지 않는다 — 도구 호출마다 생기는 내부 REST 요청이 한도에 들어간다.
        if (!MCP_PATH_RE.test(req.path) && !opts.limiter.hit(auth.tokenId)) {
          send(req, res, tokenProblem('too-many-requests', 429, 'E_TOKEN_RATE_LIMIT'));
          return;
        }
        req.tokenAuth = auth;
        next();
      },
      (err: unknown) => next(err),
    );
  };
}

/** 토큰 요청이면 건너뛰는 미들웨어 래퍼(세션·CSRF). */
export function unlessToken(mw: RequestHandler): RequestHandler {
  return (req, res, next) => {
    if (req.tokenAuth) {
      next();
      return;
    }
    mw(req, res, next);
  };
}
