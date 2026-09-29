import { z } from 'zod';
import {
  boolQuery,
  idSchema,
  optionalText,
  pageQuerySchema,
  sortQuerySchema,
  text,
} from './common.js';

// ── 코드구분·코드(§3.5.8~9) ────────────────────────────────────────────────
export const codeClsInputSchema = z.object({
  bizAreaId: idSchema,
  codeCls: text(10, 1),
  codeClsNm: text(100, 1),
  description: optionalText(500),
});
export type CodeClsInput = z.infer<typeof codeClsInputSchema>;

export const codeInputSchema = z.object({
  code: text(10, 1),
  codeNm: text(100, 1),
  sortOrder: z.int().min(-32768).max(32767).nullable().default(null),
  isActive: z.boolean().default(true),
});
export type CodeInput = z.infer<typeof codeInputSchema>;

export const codeClsListQuerySchema = pageQuerySchema.extend({
  q: z.string().trim().max(100).optional(),
  bizAreaId: z.coerce.number().int().positive().optional(),
  sort: sortQuerySchema,
});
export type CodeClsListQuery = z.output<typeof codeClsListQuerySchema>;

export const codeListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  /** false면 사용(is_active) 코드만. 기본은 전부(관리 화면). */
  includeInactive: boolQuery,
});
