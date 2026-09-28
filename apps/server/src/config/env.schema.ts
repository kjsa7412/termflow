import { DIALECTS, PASSWORD_POLICY } from '@termflow/shared';
import { z } from 'zod';

/**
 * 서버 환경 변수 스키마(설계서 §2.8 환경 변수 표, §12.5, 부록 B.3 `.env.example`와 같은 이름).
 * 빈 문자열은 "값 없음"으로 본다(.env.example의 `KEY=` 행).
 *
 * production 필수 규칙(§7.5, 부록 B.3):
 *  - TERMFLOW_ADMIN_PASSWORD: 없으면 기동 실패(dev 기본값 `admin1234!`)
 *  - TERMFLOW_SESSION_SECRET: 32바이트 이상(dev는 고정 개발용 값으로 대체하고 경고)
 */
const required = z.string().trim().min(1);
const minutes = z
  .string()
  .regex(/^\d+m$/, '분 단위(예: 60m)여야 합니다')
  .default('60m');

export const DEV_ADMIN_PASSWORD = 'admin1234!';
export const DEV_SESSION_SECRET = 'termflow-dev-session-secret-do-not-use-in-prod';
export const SESSION_SECRET_MIN_BYTES = 32;

const envObject = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  TERMFLOW_DB_URL: required.refine((v) => /^postgres(ql)?:\/\//.test(v), {
    message: 'postgres://호스트:포트/DB 형식이어야 합니다',
  }),
  TERMFLOW_DB_USER: required.default('termflow'),
  TERMFLOW_DB_PASSWORD: required,
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  TERMFLOW_ADMIN_LOGIN: required.default('admin'),
  TERMFLOW_ADMIN_PASSWORD: z.string().optional(),
  TERMFLOW_SESSION_SECRET: z.string().optional(),
  TERMFLOW_SESSION_TIMEOUT: minutes,
  LOCKOUT_MAX: z.coerce.number().int().min(1).max(100).default(PASSWORD_POLICY.lockoutMaxFailures),
  LOCKOUT_MINUTES: z.coerce.number().int().min(1).max(1440).default(PASSWORD_POLICY.lockoutMinutes),

  TERMFLOW_UPLOAD_MAX_MB: z.coerce.number().int().min(1).max(100).default(10),
  TERMFLOW_DEFAULT_DIALECT: z.enum(DIALECTS).default('POSTGRESQL'),
  TERMFLOW_ORACLE_COMPAT: z.enum(['12.1', '19c', '23ai']).default('19c'),
  TERMFLOW_TEST_DIALECTS: z
    .string()
    .default('')
    .refine((v) => v.split(',').every((d) => ['', 'oracle', 'mysql'].includes(d.trim())), {
      message: 'oracle,mysql 중에서 쉼표로 구분합니다',
    }),
  TERMFLOW_CACHE_MAX_PROJECTS: z.coerce.number().int().min(1).max(1000).default(20),

  TERMFLOW_LEGACY_DUMP: z.string().default('/seed/dump-gen_table-new.sql'),
  TERMFLOW_REPORT_DIR: z.string().default('./migration/report'),
});

export const envSchema = envObject
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    if (!env.TERMFLOW_ADMIN_PASSWORD || env.TERMFLOW_ADMIN_PASSWORD.trim() === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['TERMFLOW_ADMIN_PASSWORD'],
        message: 'production에서는 필수입니다',
      });
    }
    if (Buffer.byteLength(env.TERMFLOW_SESSION_SECRET ?? '', 'utf8') < SESSION_SECRET_MIN_BYTES) {
      ctx.addIssue({
        code: 'custom',
        path: ['TERMFLOW_SESSION_SECRET'],
        message: `production에서는 ${SESSION_SECRET_MIN_BYTES}바이트 이상이 필요합니다`,
      });
    }
  })
  .transform((env) => ({
    ...env,
    TERMFLOW_ADMIN_PASSWORD: env.TERMFLOW_ADMIN_PASSWORD || DEV_ADMIN_PASSWORD,
    TERMFLOW_SESSION_SECRET: env.TERMFLOW_SESSION_SECRET || DEV_SESSION_SECRET,
    /** dev 기본값을 썼는지(기동 로그 경고용). */
    usedDevDefaults: [
      ...(env.TERMFLOW_ADMIN_PASSWORD ? [] : ['TERMFLOW_ADMIN_PASSWORD']),
      ...(env.TERMFLOW_SESSION_SECRET ? [] : ['TERMFLOW_SESSION_SECRET']),
    ],
  }));

export type Env = z.infer<typeof envSchema>;

/** `60m` → 밀리초. */
export function sessionTimeoutMs(env: Pick<Env, 'TERMFLOW_SESSION_TIMEOUT'>): number {
  return Number.parseInt(env.TERMFLOW_SESSION_TIMEOUT, 10) * 60_000;
}

export type EnvParseResult =
  | { ok: true; env: Env }
  | { ok: false; missing: string[]; invalid: { name: string; message: string }[] };

const SCHEMA_KEYS = Object.keys(envObject.shape);

/** 스키마에 정의된 키만 골라 빈 문자열을 undefined로 바꾼다. */
function pickDefined(source: Record<string, unknown>): Record<string, string | undefined> {
  const picked: Record<string, string | undefined> = {};
  for (const key of SCHEMA_KEYS) {
    const value = source[key];
    picked[key] = typeof value === 'string' && value.trim() !== '' ? value : undefined;
  }
  return picked;
}

export function parseEnv(source: Record<string, unknown>): EnvParseResult {
  const input = pickDefined(source);
  const result = envSchema.safeParse(input);
  if (result.success) {
    return { ok: true, env: result.data };
  }
  const missing = new Set<string>();
  const invalid = new Map<string, string>();
  for (const issue of result.error.issues) {
    const name = String(issue.path[0] ?? '(root)');
    if (input[name] === undefined) {
      missing.add(name);
    } else if (!invalid.has(name)) {
      invalid.set(name, issue.message);
    }
  }
  return {
    ok: false,
    missing: [...missing].sort(),
    invalid: [...invalid].map(([name, message]) => ({ name, message })),
  };
}

/** @nestjs/config `validate` 훅용. main.ts에서 먼저 검증하므로 여기서는 실패하지 않는 것이 정상이다. */
export function validateEnv(source: Record<string, unknown>): Env {
  const result = parseEnv(source);
  if (!result.ok) {
    const invalidNames = result.invalid.map((i) => i.name).join(',');
    throw new Error(
      `환경 변수 검증 실패: 누락=${result.missing.join(',')} 형식 오류=${invalidNames}`,
    );
  }
  return result.env;
}
