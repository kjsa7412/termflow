import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  PROBLEM_TITLES,
  problemTypeUri,
  type ProblemDetail,
  type ProblemType,
} from '@termflow/shared';
import type { Request, Response } from 'express';
import { ProblemException } from './problem.exception.js';

const STATUS_TYPES: Record<number, { type: ProblemType; code: string }> = {
  400: { type: 'bad-request', code: 'E_BAD_REQUEST' },
  401: { type: 'unauthorized', code: 'E_UNAUTHORIZED' },
  403: { type: 'forbidden', code: 'E_FORBIDDEN' },
  404: { type: 'not-found', code: 'E_NOT_FOUND' },
  409: { type: 'conflict', code: 'E_CONFLICT' },
  413: { type: 'upload-too-large', code: 'E_UPLOAD_TOO_LARGE' },
  422: { type: 'validation', code: 'E_VALIDATION' },
  423: { type: 'locked', code: 'E_LOCKED' },
};

/** pg 오류(drizzle 0.45는 `DrizzleQueryError.cause`에 원 오류를 둔다 — PoC T1.3)를 찾는다. */
export function findPgError(e: unknown): { code: string; constraint?: string } | undefined {
  for (let cur: unknown = e, depth = 0; cur && depth < 5; depth++) {
    const c = cur as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof c.code === 'string' && /^[0-9A-Z]{5}$/.test(c.code)) {
      return {
        code: c.code,
        ...(typeof c.constraint === 'string' ? { constraint: c.constraint } : {}),
      };
    }
    cur = c.cause;
  }
  return undefined;
}

/** csrf-csrf(http-errors)의 오류 표식. */
function isCsrfError(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === 'EBADCSRFTOKEN';
}

/**
 * 모든 예외를 RFC 9457 ProblemDetail(+ code·errors[]) JSON으로 바꾼다(설계서 §9.2, T2.6).
 * 500은 내부 정보를 노출하지 않고 로그에만 남긴다.
 */
@Catch()
export class ProblemDetailFilter implements ExceptionFilter {
  private readonly logger = new Logger('ProblemDetail');

  toProblem(exception: unknown, instance?: string): ProblemDetail {
    if (exception instanceof ProblemException) return exception.toProblem(instance);
    const base = (type: ProblemType, status: number, code: string, detail?: string) => ({
      type: problemTypeUri(type),
      title: PROBLEM_TITLES[type],
      status,
      ...(detail ? { detail } : {}),
      ...(instance ? { instance } : {}),
      code,
    });
    if (isCsrfError(exception)) {
      return base('csrf', 403, 'E_CSRF', 'CSRF 토큰이 올바르지 않습니다');
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const m = STATUS_TYPES[status] ?? {
        type: status >= 500 ? 'internal' : 'bad-request',
        code: status >= 500 ? 'E_INTERNAL' : 'E_BAD_REQUEST',
      };
      return base(m.type, status, m.code, status >= 500 ? undefined : exception.message);
    }
    const pgErr = findPgError(exception);
    if (pgErr?.code === '23505') {
      return {
        ...base('duplicate-key', 409, 'E_DUPLICATE_KEY', '이미 존재하는 값입니다'),
        ...(pgErr.constraint ? { constraint: pgErr.constraint } : {}),
      };
    }
    return base('internal', 500, 'E_INTERNAL', '서버 오류가 발생했습니다');
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    // /health(terminus)의 503 본문 {status, info, error, details}은 모니터링 형식 그대로 둔다(§12.3)
    if (exception instanceof HttpException && req.path === '/health') {
      res.status(exception.getStatus()).json(exception.getResponse());
      return;
    }
    const problem = this.toProblem(exception, req.originalUrl);
    if (problem.status >= 500) {
      this.logger.error(
        { err: exception, method: req.method, url: req.originalUrl },
        '처리되지 않은 오류',
      );
    }
    res.status(problem.status).type('application/problem+json').json(problem);
  }
}
