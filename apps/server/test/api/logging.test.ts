import { Writable } from 'node:stream';
import { Body, Controller, HttpCode, Post, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger, LoggerModule, PinoLogger } from 'nestjs-pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggerParams, REDACT_CENSOR } from '../../src/common/logging/logger.config.js';

// T2.7 로깅: 로그인 요청 로그에 비밀번호·쿠키·CSRF 토큰 미출력(§12.2 비밀 정보 마스킹)
const lines: string[] = [];
const sink = new Writable({
  write(chunk: Buffer, _enc, cb) {
    lines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
    cb();
  },
});

const PASSWORD = 'S3cret-Passw0rd!';
const COOKIE = 'tf.sid=s%3Asecret-session-id.sig';
const CSRF = 'csrf-token-value-123';

@Controller('api/v1/auth')
class FakeAuthController {
  constructor(private readonly log: PinoLogger) {}
  @Post('login')
  @HttpCode(200)
  login(@Body() body: { loginId: string; password: string }) {
    // 실수로 본문을 통째로 로그에 남겨도 마스킹되는지
    this.log.info({ body, user: { loginId: body.loginId, password: body.password } }, 'login');
    return { ok: true };
  }
}

describe('logging (T2.7)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [LoggerModule.forRoot(loggerParams({ NODE_ENV: 'test', LOG_LEVEL: 'info' }, sink))],
      controllers: [FakeAuthController],
    }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.useLogger(app.get(Logger));
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it('요청 로그: reqId·소요·user 필드, 비밀값은 [REDACTED]', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Cookie', COOKIE)
      .set('X-XSRF-TOKEN', CSRF)
      .set('X-Request-Id', 'req-42')
      .send({ loginId: 'hong', password: PASSWORD })
      .expect(200);
    await new Promise((r) => setTimeout(r, 50));
    const all = lines.join('\n');
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain('secret-session-id');
    expect(all).not.toContain(CSRF);
    expect(all).toContain(REDACT_CENSOR);

    const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const reqLog = entries.find((e) => e['msg'] === 'request completed');
    expect(reqLog).toBeDefined();
    expect(reqLog).toMatchObject({ reqId: 'req-42', user: null });
    expect(typeof reqLog?.['responseTime']).toBe('number');
    const req = reqLog?.['req'] as { headers: Record<string, string> };
    expect(req.headers['cookie']).toBe(REDACT_CENSOR);
    expect(req.headers['x-xsrf-token']).toBe(REDACT_CENSOR);

    const appLog = entries.find((e) => e['msg'] === 'login') as {
      body: { password: string; loginId: string };
      user: { password: string };
      reqId?: string;
    };
    expect(appLog.body.password).toBe(REDACT_CENSOR);
    expect(appLog.user.password).toBe(REDACT_CENSOR);
    expect(appLog.body.loginId).toBe('hong');
  });
});
