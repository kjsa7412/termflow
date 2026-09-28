import { z } from 'zod';
import { idSchema, optionalText, text } from './common.js';

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
