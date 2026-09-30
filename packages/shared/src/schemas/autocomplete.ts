import { z } from 'zod';
import { AUTOCOMPLETE_BATCH_MAX } from '../limits.js';
import { idSchema, text } from './common.js';

/**
 * POST P/autocomplete/columns(§5.4). 빈 입력은 400. `bizAreaId`(선택) = 편집 중 테이블의 업무구분 —
 * 코드성 후보에서 같은 업무구분 코드구분을 +10점(§5.6).
 */
export const autocompleteRequestSchema = z.object({
  logicalNm: text(200, 1),
  excludeColumnId: idSchema.nullable().default(null),
  bizAreaId: idSchema.nullable().default(null),
});
export type AutocompleteRequest = z.infer<typeof autocompleteRequestSchema>;

/** POST P/autocomplete/columns/batch — 논리명 최대 200개(Ctrl+V 여러 줄, T9.8). */
export const autocompleteBatchSchema = z.object({
  logicalNms: z.array(text(200, 1)).min(1).max(AUTOCOMPLETE_BATCH_MAX),
  bizAreaId: idSchema.nullable().default(null),
});
export type AutocompleteBatchRequest = z.infer<typeof autocompleteBatchSchema>;
