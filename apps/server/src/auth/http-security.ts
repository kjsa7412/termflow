import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import connectPgSimple from 'connect-pg-simple';
import cookieParser from 'cookie-parser';
import { doubleCsrf, type DoubleCsrfUtilities } from 'csrf-csrf';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import session from 'express-session';
import helmet from 'helmet';
import type pg from 'pg';
import { API_ERROR_CODES } from '@termflow/shared';
import { ForbiddenProblem } from '../common/problem/problem.exception.js';
import { sessionTimeoutMs, type Env } from '../config/env.schema.js';
import { ApiTokenService } from './api-token.service.js';
import { bearerMiddleware, TokenRateLimiter, unlessToken } from './bearer.js';

/**
 * 세션·CSRF·보안 헤더 본 구성(T4.1, 설계서 §7.1·§7.4·§12.2, PoC_결과 §6 확정 설정).
 *  - 쿠키 `tf.sid`: HttpOnly, SameSite=Lax, prod Secure(TERMFLOW_SECURE_COOKIE, 기본 auto = HTTPS 요청일 때), rolling, 만료 TERMFLOW_SESSION_TIMEOUT(기본 60분)
 *  - 저장소 connect-pg-simple → `tf_session`(부록 A, 재기동에도 유지)
 *  - CSRF csrf-csrf double-submit: 쿠키 `XSRF-TOKEN`(HttpOnly=false) + 헤더 `X-XSRF-TOKEN`, 세션 ID 바인딩
 *  - 쿠키 이름 접미어(CR-15 C4): 같은 호스트 다른 포트 인스턴스와 겹치지 않게 `tf.sid.<접미어>`·`XSRF-TOKEN-<접미어>`
 *  - helmet: CSP `script-src 'self'`, nosniff, X-Frame-Options DENY
 *  - `trust proxy` 1(Q1 기본값: 사내 리버스 프록시 뒤 HTTP)
 */
export const SESSION_COOKIE = 'tf.sid';
export const CSRF_COOKIE = 'XSRF-TOKEN';
export const CSRF_HEADER = 'x-xsrf-token';

type CookieEnv = Partial<Pick<Env, 'TERMFLOW_COOKIE_SUFFIX' | 'TERMFLOW_APP_PORT'>>;
type SecurityEnv = Pick<Env, 'NODE_ENV' | 'TERMFLOW_SESSION_SECRET' | 'TERMFLOW_SESSION_TIMEOUT'> &
  Partial<Pick<Env, 'TERMFLOW_SECURE_COOKIE'>> &
  CookieEnv;

export type CsrfUtils = DoubleCsrfUtilities;
export interface CookieNames {
  session: string;
  csrf: string;
}
export const COOKIE_NAMES = Symbol('COOKIE_NAMES');

/** 쿠키 이름(CR-15 C4): TERMFLOW_COOKIE_SUFFIX → 없으면 TERMFLOW_APP_PORT → 없으면 접미어 없음. */
export function cookieNames(env: CookieEnv): CookieNames {
  const suffix =
    env.TERMFLOW_COOKIE_SUFFIX ?? (env.TERMFLOW_APP_PORT ? String(env.TERMFLOW_APP_PORT) : '');
  return suffix
    ? { session: `${SESSION_COOKIE}.${suffix}`, csrf: `${CSRF_COOKIE}-${suffix}` }
    : { session: SESSION_COOKIE, csrf: CSRF_COOKIE };
}

/** ConfigService에서 쿠키 이름 계산용 값만 꺼낸다(모듈·main.ts 공용). */
export function cookieEnvOf(config: ConfigService<Env, true>): CookieEnv {
  return {
    TERMFLOW_COOKIE_SUFFIX: config.get('TERMFLOW_COOKIE_SUFFIX', { infer: true }),
    TERMFLOW_APP_PORT: config.get('TERMFLOW_APP_PORT', { infer: true }),
  };
}

/**
 * 쿠키 Secure 결정(CR-11a C5). dev·test는 false. production은 TERMFLOW_SECURE_COOKIE(기본 auto):
 * `'auto'`는 express-session이 요청별로 판단(req.secure — trust proxy 1이라 X-Forwarded-Proto: https 포함).
 * 고정 true였을 때 http://localhost:8080 직접 접속에서 세션 쿠키가 발급되지 않아 로그인이 CSRF 403으로 실패했다.
 */
export function secureCookieMode(
  env: Pick<SecurityEnv, 'NODE_ENV' | 'TERMFLOW_SECURE_COOKIE'>,
): boolean | 'auto' {
  if (env.NODE_ENV !== 'production') return false;
  const mode = env.TERMFLOW_SECURE_COOKIE ?? 'auto';
  return mode === 'auto' ? 'auto' : mode === 'true';
}

export function createCsrf(env: SecurityEnv): CsrfUtils {
  // CSRF 쿠키는 JS가 읽는 double-submit 값(세션 ID에 HMAC 바인딩)이라 auto에서는 Secure를 붙이지 않는다.
  const secure = secureCookieMode(env) === true;
  return doubleCsrf({
    getSecret: () => env.TERMFLOW_SESSION_SECRET,
    getSessionIdentifier: (req) => req.sessionID,
    cookieName: cookieNames(env).csrf,
    cookieOptions: { httpOnly: false, sameSite: 'lax', secure, path: '/' },
    getCsrfTokenFromRequest: (req) => req.get(CSRF_HEADER),
  });
}

export function createSessionStore(pool: pg.Pool): session.Store & { close(): void } {
  const PgStore = connectPgSimple(session);
  return new PgStore({ pool, tableName: 'tf_session', createTableIfMissing: false });
}

/** CSRF 검사 실패를 Express 기본 오류 처리기 대신 ProblemDetail 403(type csrf)로 응답(PoC T1.5 ④). */
export function csrfMiddleware(csrf: CsrfUtils): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    csrf.doubleCsrfProtection(req, res, (err?: unknown) => {
      if (err) {
        const p = new ForbiddenProblem(API_ERROR_CODES.E_CSRF, 'csrf');
        res.status(403).type('application/problem+json').json(p.toProblem(req.originalUrl));
        return;
      }
      next();
    });
  };
}

export function helmetMiddleware(
  env: Pick<Env, 'NODE_ENV'> & Partial<Pick<Env, 'TERMFLOW_SECURE_COOKIE'>>,
): RequestHandler {
  const isProd = env.NODE_ENV === 'production';
  const mode = secureCookieMode(env);
  // COOP는 신뢰할 수 있는 출처(HTTPS·localhost)에서만 쓰인다. 사내 http://PC이름:7340에서는 브라우저가 무시하며 매 페이지
  // 콘솔에 오류를 남겼다 → HTTP가 아닐 때만 보낸다(CR-15 C17). 개발·테스트(localhost)는 그대로.
  const h = helmet({
    crossOriginOpenerPolicy: false,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        // TLS가 보장될 때(true)만. auto에서 켜면 http://PC이름:8080 접속 시 브라우저가 정적 파일을 https로 올려 받다 실패한다.
        ...(mode === true ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    frameguard: { action: 'deny' },
    // 사내 HTTP(프록시 뒤) 운영이 기본이라 HSTS는 prod에서만(프록시가 TLS 종단, HTTP 응답의 HSTS는 브라우저가 무시)
    strictTransportSecurity: isProd && mode !== false,
  });
  return (req, res, next) => {
    const trusted = req.secure || req.hostname === 'localhost' || req.hostname === '127.0.0.1';
    if (!isProd || trusted) res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    h(req, res, next);
  };
}

export function sessionMiddleware(env: SecurityEnv, store: session.Store): RequestHandler {
  return session({
    name: cookieNames(env).session,
    secret: env.TERMFLOW_SESSION_SECRET,
    store,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookieMode(env),
      maxAge: sessionTimeoutMs(env),
      path: '/',
    },
  });
}

export const CSRF_UTILS = Symbol('CSRF_UTILS');
export const SESSION_STORE = Symbol('SESSION_STORE');

/**
 * Nest 앱에 보안 미들웨어를 건다(main.ts·테스트 공용). 순서: helmet → cookie-parser → bearer(접근 토큰, CR-18) → session → csrf.
 * Bearer로 인증된 요청은 세션·CSRF를 건너뛴다(쿠키를 쓰지 않는 요청이라 CSRF 대상이 아니다).
 * nestjs-cls 미들웨어(모듈 미들웨어)는 이 뒤에 실행되어 세션의 로그인 ID를 감사 컨텍스트에 담는다.
 */
export function applyHttpSecurity(app: INestApplication): void {
  const config = app.get(ConfigService<Env, true>);
  const env: SecurityEnv = {
    NODE_ENV: config.get('NODE_ENV', { infer: true }),
    TERMFLOW_SESSION_SECRET: config.get('TERMFLOW_SESSION_SECRET', { infer: true }),
    TERMFLOW_SESSION_TIMEOUT: config.get('TERMFLOW_SESSION_TIMEOUT', { infer: true }),
    TERMFLOW_SECURE_COOKIE: config.get('TERMFLOW_SECURE_COOKIE', { infer: true }),
    ...cookieEnvOf(config),
  };
  const express = app.getHttpAdapter().getInstance() as { set(k: string, v: unknown): void };
  express.set('trust proxy', 1);
  app.use(helmetMiddleware(env));
  app.use(cookieParser());
  app.use(
    bearerMiddleware(app.get(ApiTokenService), {
      enabled: config.get('TERMFLOW_MCP_ENABLED', { infer: true }) === 'true',
      limiter: new TokenRateLimiter(config.get('TERMFLOW_TOKEN_RATE_PER_MIN', { infer: true })),
    }),
  );
  app.use(unlessToken(sessionMiddleware(env, app.get<session.Store>(SESSION_STORE))));
  app.use(unlessToken(csrfMiddleware(app.get<CsrfUtils>(CSRF_UTILS))));
}
