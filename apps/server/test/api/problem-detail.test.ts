import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Post,
  Query,
  type INestApplication,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { pageQuerySchema, PROBLEM_TYPE_BASE, termInputSchema } from '@termflow/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZodValidationPipe } from '../../src/common/pipes/zod-validation.pipe.js';
import { ProblemDetailFilter } from '../../src/common/problem/problem-detail.filter.js';
import {
  ConflictProblem,
  ForbiddenProblem,
  UnauthorizedProblem,
  ValidationProblem,
} from '../../src/common/problem/problem.exception.js';

// T2.6 오류 형식: 400/401/403/404/409/422/500 각각 RFC 9457 + code 규격(§9.2)
@Controller('p')
class ProbeController {
  @Post('zod')
  zod(@Body(new ZodValidationPipe(termInputSchema)) body: unknown) {
    return body;
  }
  @Get('page')
  page(@Query(new ZodValidationPipe(pageQuerySchema)) q: unknown) {
    return q;
  }
  @Get('401')
  unauthorized() {
    throw new UnauthorizedProblem();
  }
  @Get('403')
  forbidden() {
    throw new ForbiddenProblem();
  }
  @Get('403-csrf')
  csrf() {
    throw Object.assign(new Error('invalid csrf token'), { status: 403, code: 'EBADCSRFTOKEN' });
  }
  @Get('404')
  notFound() {
    throw new NotFoundException('테이블 17이 없습니다');
  }
  @Get('409')
  conflict() {
    throw new ConflictProblem('E_VERSION_CONFLICT', '김민수이(가) 12:30:05에 저장했습니다.', {
      yourVersion: 3,
      currentVersion: 4,
    });
  }
  @Get('409-pg')
  pgDup() {
    const pgErr = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'uk_std_term_kor',
    });
    throw Object.assign(new Error('Failed query: insert …'), { cause: pgErr });
  }
  @Get('422')
  validation() {
    throw new ValidationProblem(
      [
        {
          code: 'E_PHYS_DUP',
          target: 'column',
          columnId: 305,
          rowIndex: 4,
          field: 'physicalNm',
          message: '물리명 RSCH_PRJ_ID이(가) 2행과 중복됩니다',
        },
      ],
      [{ code: 'W_PK_NONE', target: 'table', message: 'PK가 없습니다' }],
    );
  }
  @Get('500')
  boom() {
    throw new Error('secret internal detail');
  }
}

describe('ProblemDetailFilter (T2.6)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [{ provide: APP_FILTER, useClass: ProblemDetailFilter }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  const get = (path: string) => request(app.getHttpServer()).get(path);

  it('400: zod 파이프 형식 오류 → errors[] field·message', async () => {
    const res = await request(app.getHttpServer())
      .post('/p/zod')
      .send({ termKor: '', termPhysical: 'bad-x' })
      .expect(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({
      type: `${PROBLEM_TYPE_BASE}bad-request`,
      title: '요청 형식 오류',
      status: 400,
      code: 'E_BAD_REQUEST',
      instance: '/p/zod',
    });
    const fields = (res.body as { errors: { field: string; code: string }[] }).errors.map(
      (e) => e.field,
    );
    expect(fields.sort()).toEqual(['termKor', 'termPhysical']);
    const q = await get('/p/page?size=500').expect(400);
    expect((q.body as { errors: { field: string }[] }).errors[0]?.field).toBe('size');
    const ok = await get('/p/page?page=2').expect(200);
    expect(ok.body).toEqual({ page: 2, size: 20 });
  });

  it('401·403(권한·CSRF)·404', async () => {
    expect((await get('/p/401').expect(401)).body).toMatchObject({
      type: `${PROBLEM_TYPE_BASE}unauthorized`,
      status: 401,
      code: 'E_UNAUTHORIZED',
    });
    expect((await get('/p/403').expect(403)).body).toMatchObject({
      type: `${PROBLEM_TYPE_BASE}forbidden`,
      code: 'E_FORBIDDEN',
    });
    expect((await get('/p/403-csrf').expect(403)).body).toMatchObject({
      type: `${PROBLEM_TYPE_BASE}csrf`,
      code: 'E_CSRF',
    });
    expect((await get('/p/404').expect(404)).body).toMatchObject({
      type: `${PROBLEM_TYPE_BASE}not-found`,
      status: 404,
      code: 'E_NOT_FOUND',
      detail: '테이블 17이 없습니다',
    });
  });

  it('409: 버전 충돌 확장 필드, pg 23505(cause 안) → duplicate-key', async () => {
    expect((await get('/p/409').expect(409)).body).toEqual({
      type: `${PROBLEM_TYPE_BASE}version-conflict`,
      title: '저장 충돌',
      status: 409,
      detail: '김민수이(가) 12:30:05에 저장했습니다.',
      instance: '/p/409',
      code: 'E_VERSION_CONFLICT',
      yourVersion: 3,
      currentVersion: 4,
    });
    expect((await get('/p/409-pg').expect(409)).body).toMatchObject({
      type: `${PROBLEM_TYPE_BASE}duplicate-key`,
      code: 'E_DUPLICATE_KEY',
      constraint: 'uk_std_term_kor',
    });
  });

  it('422: errors[]·warnings[] (§9.2 예시 형태)', async () => {
    const res = await get('/p/422').expect(422);
    expect(res.body).toMatchObject({
      type: `${PROBLEM_TYPE_BASE}validation`,
      title: '검증 오류',
      status: 422,
      detail: '오류 1건, 경고 1건',
      code: 'E_VALIDATION',
      errors: [{ code: 'E_PHYS_DUP', columnId: 305, rowIndex: 4, field: 'physicalNm' }],
      warnings: [{ code: 'W_PK_NONE', target: 'table' }],
    });
  });

  it('500: 내부 정보를 노출하지 않는다', async () => {
    const res = await get('/p/500').expect(500);
    expect(res.body).toEqual({
      type: `${PROBLEM_TYPE_BASE}internal`,
      title: '서버 오류',
      status: 500,
      detail: '서버 오류가 발생했습니다',
      instance: '/p/500',
      code: 'E_INTERNAL',
    });
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
});
