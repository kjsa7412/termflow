import { z } from 'zod';
import { TYPE_SOURCES } from '../enums.js';
import { DOMAIN_PHYSICAL_RE } from '../validation/identifier.js';
import { optionalLength, optionalText, stdTypeSchema, text } from './common.js';

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
export const domainRecalculateSchema = z.object({ scope: z.enum(['REVIEW_ONLY', 'ALL_AUTO']) });
export const domainPhysicalSchema = z.string().regex(DOMAIN_PHYSICAL_RE).max(63);
