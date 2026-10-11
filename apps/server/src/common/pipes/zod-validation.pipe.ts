import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ValidationIssue } from '@termflow/shared';
import type { z } from 'zod';
import { BadRequestProblem } from '../problem/problem.exception.js';

/**
 * zod 스키마 검증 파이프(설계서 §2.5.5, T2.6). 실패하면 400 ProblemDetail(`errors[]`: field·message).
 * 사용: `@Body(new ZodValidationPipe(tableSaveSchema)) body: TableSaveInput`.
 * 업무 규칙(§5.7 E_*)은 422 ValidationProblem으로 서비스가 따로 보고한다.
 */
@Injectable()
export class ZodValidationPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  /** `schema`는 외부 연동 도구 목록(CR-18)이 입력 스키마를 만들 때도 읽는다. */
  constructor(readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    const errors: ValidationIssue[] = result.error.issues.map((i) => ({
      code: 'E_FORMAT',
      target: 'field',
      field: i.path.map(String).join('.') || '(root)',
      message: i.message,
    }));
    throw new BadRequestProblem(errors, `요청 형식 오류 ${errors.length}건`);
  }
}
