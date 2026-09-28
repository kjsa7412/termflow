import { z } from 'zod';
import { STD_TYPES } from '../enums.js';
import { PAGE_DEFAULT, PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from '../limits.js';
import { IDENTIFIER_RE, PROJECT_KEY_RE } from '../validation/identifier.js';

/** 정수 ID(IDENTITY). */
export const idSchema = z.int().positive();
/** 선택 ID: 생략·null → null. */
export const optionalId = idSchema.nullable().default(null);

/** 앞뒤 공백 제거 후 길이 제한 문자열. */
export const text = (max: number, min = 0) => z.string().trim().min(min).max(max);
/** 선택 문자열: 생략·null → null, 공백만이면 null. */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .default(null)
    .transform((v) => (v === '' ? null : v));

export const stdTypeSchema = z.enum(STD_TYPES);
export const identifierSchema = z.string().trim().regex(IDENTIFIER_RE);
export const projectKeySchema = z.string().trim().regex(PROJECT_KEY_RE);

/** 길이·스케일(0 이상 정수, 선택). 범위 규칙(E_TYPE_LEN_RANGE)은 업무 검증이 판정한다. */
export const optionalLength = z.int().min(-1_000_000).max(1_000_000).nullable().default(null);

/** 쿼리 문자열 → 정수(페이지네이션, §9.1). */
export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(PAGE_DEFAULT),
  size: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

/** `sort=field,asc|desc`(복수 허용). 허용 필드 검사는 서버 화이트리스트가 한다(T2.8). */
export const sortQuerySchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]));

/** 불리언 쿼리(`true`/`false`). */
export const boolQuery = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true'));
