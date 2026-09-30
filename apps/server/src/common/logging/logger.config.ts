import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
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

/**
 * prod 파일 로그(§12.3, T11.5): 작업 디렉터리 기준 `logs/termflow.YYYY-MM-DD.N.log`, 자정(TZ=Asia/Seoul)마다 새 파일.
 * 보관 30개(현재 파일 포함, 롤 시 정리) + 기동 시 30일 초과 정리(pruneOldLogFiles). `removeOtherLogFiles`를 켜야 재기동 전 프로세스가 만든 파일도 정리 대상이 된다
 * (끄면 pino-roll은 자기 프로세스가 만든 파일만 센다 — 컨테이너 재기동이 잦으면 30일을 넘겨 쌓인다).
 * 컨테이너에서는 `/app/logs`(compose `./logs` 볼륨).
 */
export const LOG_FILE_ROLL = {
  file: 'logs/termflow.log',
  frequency: 'daily',
  dateFormat: 'yyyy-MM-dd',
  limit: { count: 30, removeOtherLogFiles: true },
  mkdir: true,
} as const;

/** 파일 로그 보관 일수(§12.3 "일 단위 롤링 30일"). */
export const LOG_RETENTION_DAYS = 30;
const LOG_FILE_PATTERN = /^termflow\.(\d{4})-(\d{2})-(\d{2})\.\d+\.log$/;

/**
 * 기동 시 보관 기간을 넘긴 파일 로그를 지운다(CR-11a C9). pino-roll의 `limit`은 **자정 롤 시점에만** 정리하므로
 * 밤에 PC를 끄는 운영(매일 새로 기동, 자정 롤 없음)에서는 파일이 끝없이 쌓인다. 파일 이름의 날짜가
 * 오늘 기준 `keepDays`일 전보다 이르면 삭제(오늘 포함 `keepDays`일 유지). 다른 이름의 파일은 건드리지 않는다.
 * @returns 삭제한 파일 이름
 */
export function pruneOldLogFiles(
  dir: string = path.dirname(path.resolve(LOG_FILE_ROLL.file)),
  keepDays: number = LOG_RETENTION_DAYS,
  now: Date = new Date(),
): string[] {
  if (!existsSync(dir)) return [];
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (keepDays - 1));
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    const m = LOG_FILE_PATTERN.exec(name);
    if (!m) continue;
    const fileDay = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (fileDay < cutoff) {
      try {
        rmSync(path.join(dir, name), { force: true });
        removed.push(name);
      } catch {
        // 다른 프로세스가 잡고 있는 파일 등은 다음 기동·롤에서 다시 시도한다
      }
    }
  }
  return removed.sort();
}

type LogEnv = Pick<Env, 'NODE_ENV' | 'LOG_LEVEL'>;
type SessionReq = IncomingMessage & { session?: { user?: { loginId?: string } } };

/**
 * nestjs-pino 설정(T2.7): JSON 라인, `reqId`(X-Request-Id 또는 UUID)·`user`(로그인 ID)·소요(responseTime).
 * dev는 pino-pretty 한 줄, prod는 stdout JSON + `logs/termflow.log` 일 단위 롤링 30개(pino-roll, LOG_FILE_ROLL).
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
              { target: 'pino-roll', level: env.LOG_LEVEL, options: LOG_FILE_ROLL },
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
