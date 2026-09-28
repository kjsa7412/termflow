import { z } from 'zod';
import { IDENTIFIER_RE } from '../validation/identifier.js';
import { idSchema, optionalLength, optionalText, stdTypeSchema, text } from './common.js';

// ── 기본컬럼 세트·구성(§3.5.10) ────────────────────────────────────────────
export const defaultColSetInputSchema = z.object({
  setNm: text(50, 1),
  description: optionalText(200),
});
export const defaultColInputSchema = z.object({
  defaultColId: idSchema.nullable().default(null),
  logicalNm: text(100, 1),
  physicalNm: z.string().trim().regex(IDENTIFIER_RE).max(63),
  isPk: z.boolean().default(false),
  dataType: stdTypeSchema,
  dataLength: optionalLength,
  dataScale: optionalLength,
  isNullable: z.boolean().default(true),
  defaultVal: optionalText(200),
  colComment: optionalText(500),
});
export const defaultColsPutSchema = z.object({
  columns: z.array(defaultColInputSchema).max(100),
});
export type DefaultColInput = z.infer<typeof defaultColInputSchema>;
