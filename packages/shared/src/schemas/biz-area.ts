import { z } from 'zod';
import { BIZ_CD_RE, TABLE_PREFIX_RE } from '../validation/identifier.js';
import { optionalText, text } from './common.js';

// ── 업무구분(§4.2, §9.3 P/biz-areas) ──────────────────────────────────────────
export const bizAreaInputSchema = z.object({
  bizCd: z.string().trim().regex(BIZ_CD_RE),
  bizNm: text(100, 1),
  tablePrefix: z.string().trim().regex(TABLE_PREFIX_RE).max(20).nullable().optional(),
  sortNo: z.int().min(0).max(32767).default(0),
  useYn: z.boolean().default(true),
  description: optionalText(500),
});
export type BizAreaInput = z.infer<typeof bizAreaInputSchema>;
