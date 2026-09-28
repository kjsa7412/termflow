import { z } from 'zod';
import { TERM_STATUSES } from '../enums.js';
import { TERM_PHYSICAL_RE } from '../validation/identifier.js';
import {
  boolQuery,
  idSchema,
  optionalText,
  pageQuerySchema,
  sortQuerySchema,
  text,
} from './common.js';

// ── 용어(§4.5, §5.4 인라인 등록) ────────────────────────────────────────────
const termPhysical = z.string().trim().regex(TERM_PHYSICAL_RE).max(30);

export const termInputSchema = z.object({
  termKor: text(100, 1),
  termPhysical,
  description: optionalText(500),
  synonymRef: optionalText(200),
});
export type TermInput = z.infer<typeof termInputSchema>;

/** POST P/standards/terms/inline — PENDING으로 등록(§5.4). */
export const termInlineSchema = z.object({
  termKor: text(100, 1),
  termPhysical,
  description: optionalText(500),
});
export type TermInlineInput = z.infer<typeof termInlineSchema>;

export const termApproveSchema = z.object({
  termPhysical: termPhysical.optional(),
  description: optionalText(500).optional(),
});
export const termRejectSchema = z.object({ note: text(500, 1) });
export const termApproveBatchSchema = z.object({ termIds: z.array(idSchema).min(1).max(200) });

export const termListQuerySchema = pageQuerySchema.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(TERM_STATUSES).optional(),
  review: boolQuery,
  sort: sortQuerySchema,
});
