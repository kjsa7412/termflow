import { z } from 'zod';
import {
  boolQuery,
  optionalLength,
  optionalText,
  pageQuerySchema,
  sortQuerySchema,
  stdTypeSchema,
  text,
} from './common.js';

// ── 도메인분류(§3.5.6) ─────────────────────────────────────────────────────
/** 접미어 형식(`^[A-Z0-9_]+$`)은 서비스가 422로 판정한다(엑셀 행 검증과 같은 함수, T6.3). */
export const domainClsInputSchema = z.object({
  suffix: z.string().max(60),
  clsNm: text(500, 1),
  colType: stdTypeSchema,
  colLength: optionalLength,
  colScale: optionalLength,
  description: optionalText(200),
});
export type DomainClsInput = z.infer<typeof domainClsInputSchema>;

export const domainClsListQuerySchema = pageQuerySchema.extend({
  q: z.string().trim().max(100).optional(),
  colType: stdTypeSchema.optional(),
  review: boolQuery,
  sort: sortQuerySchema,
});
export type DomainClsListQuery = z.output<typeof domainClsListQuerySchema>;

/** DELETE `?force=true` — 사용 도메인이 있어도 삭제(도메인의 분류 연결은 SET NULL). */
export const forceQuerySchema = z.object({ force: boolQuery });
