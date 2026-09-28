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

/**
 * 세션·CSRF·보안 헤더 본 구성(T4.1, 설계서 §7.1·§7.4·§12.2, PoC_결과 §6 확정 설정).
 *  - 쿠키 `tf.sid`: HttpOnly, SameSite=Lax, prod Secure, rolling, 만료 TERMFLOW_SESSION_TIMEOUT(기본 60분)
 *  - 저장소 connect-pg-simple → `tf_session`(부록 A, 재기동에도 유지)
 *  - CSRF csrf-csrf double-submit: 쿠키 `XSRF-TOKEN`(HttpOnly=false) + 헤더 `X-XSRF-TOKEN`, 세션 ID 바인딩
 *  - helmet: CSP `script-src 'self'`, nosniff, X-Frame-Options DENY
 *  - `trust proxy` 1(Q1 기본값: 사내 리버스 프록시 뒤 HTTP)
 */
export const SESSION_COOKIE = 'tf.sid';
export const CSRF_COOKIE = 'XSRF-TOKEN';
export const CSRF_HEADER = 'x-xsrf-token';

type SecurityEnv = Pick<Env, 'NODE_ENV' | 'TERMFLOW_SESSION_SECRET' | 'TERMFLOW_SESSION_TIMEOUT'>;

export type CsrfUtils = DoubleCsrfUtilities;

export function createCsrf(env: SecurityEnv): CsrfUtils {
  const isProd = env.NODE_ENV === 'production';
  return doubleCsrf({
    getSecret: () => env.TERMFLOW_SESSION_SECRET,
    getSessionIdentifier: (req) => req.sessionID,
    cookieName: CSRF_COOKIE,
    cookieOptions: { httpOnly: false, sameSite: 'lax', secure: isProd, path: '/' },
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

export function helmetMiddleware(env: Pick<Env, 'NODE_ENV'>): RequestHandler {
  const isProd = env.NODE_ENV === 'production';
  return helmet({
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
        ...(isProd ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    frameguard: { action: 'deny' },
    // 사내 HTTP(프록시 뒤) 운영이 기본이라 HSTS는 prod에서만(프록시가 TLS 종단)
    strictTransportSecurity: isProd,
  });
}

export function sessionMiddleware(env: SecurityEnv, store: session.Store): RequestHandler {
  return session({
    name: SESSION_COOKIE,
    secret: env.TERMFLOW_SESSION_SECRET,
    store,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.NODE_ENV === 'production',
      maxAge: sessionTimeoutMs(env),
      path: '/',
    },
  });
}

export const CSRF_UTILS = Symbol('CSRF_UTILS');
export const SESSION_STORE = Symbol('SESSION_STORE');

/**
 * Nest 앱에 보안 미들웨어를 건다(main.ts·테스트 공용). 순서: helmet → cookie-parser → session → csrf.
 * nestjs-cls 미들웨어(모듈 미들웨어)는 이 뒤에 실행되어 세션의 로그인 ID를 감사 컨텍스트에 담는다.
 */
export function applyHttpSecurity(app: INestApplication): void {
  const config = app.get(ConfigService<Env, true>);
  const env: SecurityEnv = {
    NODE_ENV: config.get('NODE_ENV', { infer: true }),
    TERMFLOW_SESSION_SECRET: config.get('TERMFLOW_SESSION_SECRET', { infer: true }),
    TERMFLOW_SESSION_TIMEOUT: config.get('TERMFLOW_SESSION_TIMEOUT', { infer: true }),
  };
  const express = app.getHttpAdapter().getInstance() as { set(k: string, v: unknown): void };
  express.set('trust proxy', 1);
  app.use(helmetMiddleware(env));
  app.use(cookieParser());
  app.use(sessionMiddleware(env, app.get<session.Store>(SESSION_STORE)));
  app.use(csrfMiddleware(app.get<CsrfUtils>(CSRF_UTILS)));
}
