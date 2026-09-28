import { HttpException } from '@nestjs/common';
import {
  API_ERROR_CODES,
  PROBLEM_TITLES,
  problemTypeUri,
  type ProblemDetail,
  type ProblemType,
  type ValidationIssue,
} from '@termflow/shared';

/**
 * 도메인 예외(설계서 §9.2). 응답 본문은 ProblemDetailFilter가 RFC 9457 형식으로 만든다.
 * `extensions`는 409 version-conflict의 yourVersion·currentVersion·current 같은 확장 필드.
 */
export class ProblemException extends HttpException {
  constructor(
    readonly problemType: ProblemType,
    status: number,
    readonly code: string,
    detail?: string,
    readonly extensions: Record<string, unknown> = {},
  ) {
    super(detail ?? PROBLEM_TITLES[problemType], status);
  }

  toProblem(instance?: string): ProblemDetail {
    return {
      type: problemTypeUri(this.problemType),
      title: PROBLEM_TITLES[this.problemType],
      status: this.getStatus(),
      detail: this.message,
      ...(instance ? { instance } : {}),
      code: this.code,
      ...this.extensions,
    };
  }
}

/** 400 형식 오류(zod 등). */
export class BadRequestProblem extends ProblemException {
  constructor(errors: ValidationIssue[] = [], detail?: string, code = 'E_BAD_REQUEST') {
    super('bad-request', 400, code, detail ?? API_ERROR_CODES.E_BAD_REQUEST, { errors });
  }
}

export class UnauthorizedProblem extends ProblemException {
  constructor(detail: string = API_ERROR_CODES.E_UNAUTHORIZED) {
    super('unauthorized', 401, 'E_UNAUTHORIZED', detail);
  }
}

export class ForbiddenProblem extends ProblemException {
  constructor(
    detail: string = API_ERROR_CODES.E_FORBIDDEN,
    type: Extract<ProblemType, 'forbidden' | 'csrf' | 'password-change-required'> = 'forbidden',
  ) {
    const code =
      type === 'csrf'
        ? 'E_CSRF'
        : type === 'password-change-required'
          ? 'E_PASSWORD_CHANGE_REQUIRED'
          : 'E_FORBIDDEN';
    super(type, 403, code, detail);
  }
}

export class NotFoundProblem extends ProblemException {
  constructor(detail: string = API_ERROR_CODES.E_NOT_FOUND) {
    super('not-found', 404, 'E_NOT_FOUND', detail);
  }
}

/** 409 — 버전 충돌·중복 키·상태 충돌. type은 code에 맞춰 고른다. */
export class ConflictProblem extends ProblemException {
  constructor(
    code: string,
    detail?: string,
    extensions: Record<string, unknown> = {},
    type: Extract<
      ProblemType,
      'conflict' | 'version-conflict' | 'duplicate-key' | 'table-finalized'
    > = code === 'E_VERSION_CONFLICT'
      ? 'version-conflict'
      : code === 'E_TABLE_FINAL'
        ? 'table-finalized'
        : code.endsWith('_DUP') || code === 'E_DUPLICATE_KEY'
          ? 'duplicate-key'
          : 'conflict',
  ) {
    super(type, 409, code, detail, extensions);
  }
}

/** 422 업무 검증 오류(§5.7 E_*) — errors[]·warnings[]. */
export class ValidationProblem extends ProblemException {
  constructor(errors: ValidationIssue[], warnings: ValidationIssue[] = [], detail?: string) {
    super(
      'validation',
      422,
      'E_VALIDATION',
      detail ?? `오류 ${errors.length}건, 경고 ${warnings.length}건`,
      { errors, warnings },
    );
  }
}

/** 423 잠금 계정(§7.6). */
export class LockedProblem extends ProblemException {
  constructor(detail: string, extensions: Record<string, unknown> = {}) {
    super('locked', 423, 'E_LOCKED', detail, extensions);
  }
}
