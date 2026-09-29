import { z } from 'zod';
import { TYPE_SOURCES } from '../enums.js';
import { DOMAIN_PHYSICAL_RE } from '../validation/identifier.js';
import {
  boolQuery,
  optionalLength,
  optionalText,
  pageQuerySchema,
  sortQuerySchema,
  stdTypeSchema,
  text,
} from './common.js';

// ── 도메인(§3.5.7, §5.2 L1) ────────────────────────────────────────────────
const nm = optionalText(100);
export const domainNamesSchema = z.object({
  nm1: text(100, 1),
  nm2: nm,
  nm3: nm,
  nm4: nm,
  nm5: nm,
  nm6: nm,
  nm7: nm,
});
export const domainInputSchema = domainNamesSchema.extend({
  typeSource: z.enum(TYPE_SOURCES).default('AUTO'),
  colType: stdTypeSchema.nullable().default(null),
  colLength: optionalLength,
  colScale: optionalLength,
});
export type DomainInput = z.infer<typeof domainInputSchema>;

/** POST P/standards/domains/calculate — 입력 중 미리보기라 명칭 1도 비어 있을 수 있다. */
export const domainCalculateSchema = domainInputSchema.extend({
  nm1: nm,
  /** 수정 중인 도메인(논리명 중복 판정에서 자기 자신 제외). */
  domainId: z.int().positive().nullable().default(null),
});
export type DomainCalculateInput = z.infer<typeof domainCalculateSchema>;

export const domainRecalculateSchema = z.object({ scope: z.enum(['REVIEW_ONLY', 'ALL_AUTO']) });
export type DomainRecalculateInput = z.infer<typeof domainRecalculateSchema>;
export const domainPhysicalSchema = z.string().regex(DOMAIN_PHYSICAL_RE).max(63);

export const domainListQuerySchema = pageQuerySchema.extend({
  q: z.string().trim().max(100).optional(),
  suffix: z.string().trim().max(30).optional(),
  review: boolQuery,
  typeSource: z.enum(TYPE_SOURCES).optional(),
  /** 물리명 없음(R15: 미등록 조각). */
  noPhysical: boolQuery,
  sort: sortQuerySchema,
});
export type DomainListQuery = z.output<typeof domainListQuerySchema>;
