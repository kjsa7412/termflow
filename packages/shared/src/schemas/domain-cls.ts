import { z } from 'zod';
import { TERM_PHYSICAL_RE } from '../validation/identifier.js';
import { optionalLength, optionalText, stdTypeSchema, text } from './common.js';

// ── 도메인분류(§3.5.6) ─────────────────────────────────────────────────────
export const domainClsInputSchema = z.object({
  suffix: z.string().trim().regex(TERM_PHYSICAL_RE).max(30),
  clsNm: text(500, 1),
  colType: stdTypeSchema,
  colLength: optionalLength,
  colScale: optionalLength,
  description: optionalText(200),
});
export type DomainClsInput = z.infer<typeof domainClsInputSchema>;
