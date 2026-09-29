import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { DIALECTS, STD_TYPES, type Dialect, type StdType } from '@termflow/shared';
import { ddlResource } from './resources.js';

/**
 * 표준 타입 → 방언 타입 매핑(설계서 §6.3). 매핑 표는 DB가 아닌 동봉 리소스 YAML(`resources/ddl/dialect/*.yml`)이며
 * 로드 시 zod로 검증한다(12종 전부·자리표시자 형식). 2차에 `ddl_type_map` 테이블로 승격할 수 있게 표 구조를 유지한다.
 *
 * pattern: `{n}` 길이, `{p}` 정밀도(= 길이), `{s}` 스케일. `[ … ]`는 안의 자리표시자 값이 모두 있을 때만 출력한다.
 */
const PLACEHOLDER_RE = /\{([nps])\}/g;
const patternSchema = z
  .string()
  .min(1)
  .max(80)
  .refine((p) => /^[A-Z0-9_ (),[\]{}nps]+$/.test(p), '허용되지 않은 문자가 있습니다')
  .refine(
    (p) => (p.match(/\[/g) ?? []).length === (p.match(/\]/g) ?? []).length,
    '[ ]가 맞지 않습니다',
  );

const typeRuleSchema = z.object({
  pattern: patternSchema,
  /** 길이 상한 — 넘으면 overflow 타입 + W_TYPE_OVERFLOW(Oracle VARCHAR2 4000, MySQL VARCHAR 16383). */
  maxLength: z.int().positive().optional(),
  overflow: patternSchema.optional(),
  /** 길이가 이 값을 넘으면 바이트 초과 가능 경고(Oracle VARCHAR2 n > 1333 → W_VARCHAR_BYTES). */
  warnBytesOver: z.int().positive().optional(),
});
export type TypeRule = z.infer<typeof typeRuleSchema>;

const mappingSchema = z.object({
  dialect: z.enum(DIALECTS),
  identifierMaxLength: z.int().positive(),
  quote: z.enum(['"', '`']),
  types: z.object(
    Object.fromEntries(STD_TYPES.map((t) => [t, typeRuleSchema])) as Record<
      StdType,
      typeof typeRuleSchema
    >,
  ),
  defaults: z.object({
    CURRENT_TIMESTAMP: z.string().min(1),
    CURRENT_DATE: z.string().min(1),
    TRUE: z.string().min(1),
    FALSE: z.string().min(1),
  }),
  columnAttributeOrder: z.tuple([
    z.enum(['NULLABILITY', 'DEFAULT']),
    z.enum(['NULLABILITY', 'DEFAULT']),
  ]),
});
export type TypeMapping = z.infer<typeof mappingSchema>;

export const DIALECT_FILES: Record<Dialect, string> = {
  POSTGRESQL: 'postgresql.yml',
  ORACLE: 'oracle.yml',
  MYSQL: 'mysql.yml',
};

/** YAML 텍스트 → 검증된 매핑. 실패하면 파일·경로를 담은 오류(기동 시 발견). */
export function parseTypeMapping(text: string, source = 'yaml'): TypeMapping {
  const r = mappingSchema.safeParse(parse(text));
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`타입 매핑 ${source} 검증 실패: ${issues}`);
  }
  return r.data;
}

const cache = new Map<Dialect, TypeMapping>();

export function typeMapping(dialect: Dialect): TypeMapping {
  let m = cache.get(dialect);
  if (!m) {
    const file = DIALECT_FILES[dialect];
    m = parseTypeMapping(readFileSync(ddlResource('dialect', file), 'utf8'), file);
    if (m.dialect !== dialect) throw new Error(`${file}의 dialect가 ${dialect}가 아닙니다`);
    cache.set(dialect, m);
  }
  return m;
}

/**
 * 패턴 전개. `[ … ]` 안의 자리표시자 값이 하나라도 없으면 그 구간을 뺀다.
 * 구간 밖 자리표시자 값이 없으면 오류(검증기가 E_TYPE_LEN_MISSING으로 먼저 막는 경로).
 */
export function renderPattern(
  pattern: string,
  vals: { n: number | null; p: number | null; s: number | null },
): string {
  const fill = (seg: string, optional: boolean): string | null => {
    let missing = false;
    const out = seg.replace(PLACEHOLDER_RE, (_m, k: 'n' | 'p' | 's') => {
      const v = vals[k];
      if (v === null) {
        missing = true;
        return '';
      }
      return String(v);
    });
    if (missing) {
      if (optional) return null;
      throw new Error(`타입 패턴 ${pattern}에 필요한 값이 없습니다`);
    }
    return out;
  };
  let result = '';
  let i = 0;
  while (i < pattern.length) {
    const open = pattern.indexOf('[', i);
    if (open < 0) {
      result += fill(pattern.slice(i), false);
      break;
    }
    result += fill(pattern.slice(i, open), false);
    const close = pattern.indexOf(']', open);
    result += fill(pattern.slice(open + 1, close), true) ?? '';
    i = close + 1;
  }
  return result;
}

export interface MappedType {
  sql: string;
  /** 방언 한계로 대체·경고가 생긴 경우(W_TYPE_OVERFLOW·W_VARCHAR_BYTES). */
  warnings: { code: 'W_TYPE_OVERFLOW' | 'W_VARCHAR_BYTES'; message: string }[];
}

/** 표준 타입(3분할) → 방언 타입 문자열(§6.2 mapType). */
export function mapStdType(
  mapping: TypeMapping,
  type: StdType,
  length: number | null,
  scale: number | null,
): MappedType {
  const rule = mapping.types[type];
  const warnings: MappedType['warnings'] = [];
  if (rule.maxLength !== undefined && length !== null && length > rule.maxLength && rule.overflow) {
    warnings.push({
      code: 'W_TYPE_OVERFLOW',
      message: `${type}(${length})이(가) ${mapping.dialect} 상한 ${rule.maxLength}을 넘어 ${rule.overflow}로 생성합니다`,
    });
    return { sql: renderPattern(rule.overflow, { n: null, p: null, s: null }), warnings };
  }
  if (rule.warnBytesOver !== undefined && length !== null && length > rule.warnBytesOver) {
    warnings.push({
      code: 'W_VARCHAR_BYTES',
      message: `${mapping.dialect}에서 ${type}(${length})은(는) 바이트 상한을 넘을 수 있습니다`,
    });
  }
  return { sql: renderPattern(rule.pattern, { n: length, p: length, s: scale }), warnings };
}
