import { Controller, Get, type INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import { ClsModule } from 'nestjs-cls';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditContext, clsOptions } from '../../src/common/audit/audit-context.js';
import { CommonModule } from '../../src/common/common.module.js';
import { ProblemDetailFilter } from '../../src/common/problem/problem-detail.filter.js';

// T2.5 AuditContext(nestjs-cls): 요청 스코프에서 로그인 ID + 클라이언트 IP → Audit
@Controller('who')
class WhoController {
  constructor(private readonly ctx: AuditContext) {}
  @Get()
  who() {
    return this.ctx.current();
  }
}

describe('AuditContext (T2.5)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ClsModule.forRoot(clsOptions), CommonModule],
      controllers: [WhoController],
      providers: [{ provide: APP_FILTER, useClass: ProblemDetailFilter }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    // 세션 미들웨어 대역(T4.1 전): X-Test-User 헤더를 session.user로
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const user = req.get('x-test-user');
      Object.assign(req, { session: user ? { user: { loginId: user } } : {} });
      next();
    });
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it('로그인 사용자 → {actor, ip}(X-Forwarded-For 첫 값)', async () => {
    const res = await request(app.getHttpServer())
      .get('/who')
      .set('x-test-user', 'hong')
      .set('x-forwarded-for', '10.1.2.3, 10.0.0.1')
      .expect(200);
    expect(res.body).toEqual({ actor: 'hong', ip: '10.1.2.3' });
  });

  it('요청마다 격리된다(동시 요청)', async () => {
    const server = app.getHttpServer();
    const results = await Promise.all(
      ['a', 'b', 'c', 'd'].map((u) => request(server).get('/who').set('x-test-user', u)),
    );
    expect(results.map((r) => (r.body as { actor: string }).actor)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('미인증이면 401 ProblemDetail', async () => {
    const res = await request(app.getHttpServer()).get('/who').expect(401);
    expect(res.body).toMatchObject({ status: 401, code: 'E_UNAUTHORIZED' });
  });
});
