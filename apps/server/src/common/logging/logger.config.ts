import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import type { Env } from '../../config/env.schema.js';

/**
 * 로그 마스킹 경로(설계서 §12.2 "비밀 정보 로그 마스킹", §12.3). pino-http는 기본으로 본문을 남기지 않지만
 * 요청 헤더(cookie·CSRF)와 응답 Set-Cookie가 직렬화되므로 가리고, 객체 로그의 비밀번호 키도 가린다.
 */
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-xsrf-token"]',
  'res.headers["set-cookie"]',
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
  'req.body.initialPassword',
  'password',
  'passwordHash',
  'password_hash',
  'currentPassword',
  'newPassword',
  'initialPassword',
  'temporaryPassword',
  '*.password',
  '*.passwordHash',
  '*.password_hash',
  '*.currentPassword',
  '*.newPassword',
  '*.initialPassword',
  '*.temporaryPassword',
  '*.sessionSecret',
  '*.TERMFLOW_SESSION_SECRET',
  '*.TERMFLOW_DB_PASSWORD',
  '*.TERMFLOW_ADMIN_PASSWORD',
];
export const REDACT_CENSOR = '[REDACTED]';

type LogEnv = Pick<Env, 'NODE_ENV' | 'LOG_LEVEL'>;
type SessionReq = IncomingMessage & { session?: { user?: { loginId?: string } } };

/**
 * nestjs-pino 설정(T2.7): JSON 라인, `reqId`(X-Request-Id 또는 UUID)·`user`(로그인 ID)·소요(responseTime).
 * dev는 pino-pretty 한 줄, prod는 stdout JSON + `logs/termflow.log` 일 단위 롤링 30개(pino-roll).
 * `stream`을 주면 transport 대신 그 스트림에 쓴다(테스트용).
 */
export function loggerParams(env: LogEnv, stream?: DestinationStream): Params {
  const transport =
    stream !== undefined || env.NODE_ENV === 'test'
      ? undefined
      : env.NODE_ENV === 'production'
        ? {
            targets: [
              { target: 'pino/file', options: { destination: 1 }, level: env.LOG_LEVEL },
              {
                target: 'pino-roll',
                level: env.LOG_LEVEL,
                options: {
                  file: 'logs/termflow.log',
                  frequency: 'daily',
                  dateFormat: 'yyyy-MM-dd',
                  limit: { count: 30 },
                  mkdir: true,
                },
              },
            ],
          }
        : {
            target: 'pino-pretty',
            options: { singleLine: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
          };
  const options = {
    level: env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
    ...(transport ? { transport } : {}),
    genReqId: (req: IncomingMessage, res: ServerResponse) => {
      const header = req.headers['x-request-id'];
      const id = (Array.isArray(header) ? header[0] : header) || randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    customProps: (req: IncomingMessage) => ({
      user: (req as SessionReq).session?.user?.loginId ?? null,
    }),
    customLogLevel: (_req: IncomingMessage, res: ServerResponse, err?: Error) =>
      err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    // /health 폴링은 요청 로그에서 뺀다(사내 모니터링이 주기적으로 호출, §12.3)
    autoLogging: { ignore: (req: IncomingMessage) => req.url === '/health' },
    quietReqLogger: true,
  };
  return { pinoHttp: stream ? [options, stream] : options };
}
