import { z } from 'zod';

/**
 * 서버 환경 변수 스키마(설계서 §2.5.5, 부록 B.3 `.env.example`와 같은 이름).
 * 빈 문자열은 "값 없음"으로 본다(.env.example의 `KEY=` 행).
 */
const required = z.string().trim().min(1);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    TERMFLOW_DB_URL: required,
    TERMFLOW_DB_USER: required,
    TERMFLOW_DB_PASSWORD: required,
    DB_POOL_MAX: z.coerce.number().int().positive().default(10),

    TERMFLOW_ADMIN_LOGIN: required.default('admin'),
    TERMFLOW_ADMIN_PASSWORD: required,
    TERMFLOW_SESSION_SECRET: z.string().optional(),
    TERMFLOW_SESSION_TIMEOUT: z
      .string()
      .regex(/^\d+m$/, '분 단위(예: 60m)여야 합니다')
      .default('60m'),

    TERMFLOW_UPLOAD_MAX_MB: z.coerce.number().int().positive().default(10),
    TERMFLOW_DEFAULT_DIALECT: z.enum(['POSTGRESQL', 'ORACLE', 'MYSQL']).default('POSTGRESQL'),
    TERMFLOW_ORACLE_COMPAT: z.string().default('19c'),
    TERMFLOW_TEST_DIALECTS: z.string().default(''),
    TERMFLOW_CACHE_MAX_PROJECTS: z.coerce.number().int().positive().default(20),

    TERMFLOW_LEGACY_DUMP: z.string().default('/seed/dump-gen_table-new.sql'),
    TERMFLOW_REPORT_DIR: z.string().default('./migration/report'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && (env.TERMFLOW_SESSION_SECRET ?? '').length < 32) {
      ctx.addIssue({
        code: 'custom',
        path: ['TERMFLOW_SESSION_SECRET'],
        message: 'production에서는 32자 이상이 필요합니다',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export type EnvParseResult =
  | { ok: true; env: Env }
  | { ok: false; missing: string[]; invalid: { name: string; message: string }[] };

/** 스키마에 정의된 키만 골라 빈 문자열을 undefined로 바꾼다. */
function pickDefined(source: Record<string, unknown>): Record<string, string | undefined> {
  const picked: Record<string, string | undefined> = {};
  for (const key of Object.keys(envSchema.shape)) {
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
