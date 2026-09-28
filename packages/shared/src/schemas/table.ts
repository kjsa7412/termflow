import { z } from 'zod';
import { MATCH_TYPES, TABLE_STATUSES } from '../enums.js';
import { COMMENT_MAX_LENGTH } from '../limits.js';
import {
  idSchema,
  optionalId,
  optionalLength,
  optionalText,
  projectKeySchema,
  stdTypeSchema,
  text,
} from './common.js';

/**
 * 테이블·컬럼 저장 본문(§9.5, §8.2). 형식·길이만 검사하고, 물리명 형식·중복·타입 누락 같은
 * 업무 규칙(§5.7 E_*)은 서버 TableValidator가 행 단위 422로 보고한다(편집기 배지와 같은 코드).
 */
export const columnInputSchema = z.object({
  columnId: optionalId,
  logicalNm: text(200),
  physicalNm: text(100),
  isPk: z.boolean().default(false),
  dataType: stdTypeSchema.nullable().default(null),
  dataLength: optionalLength,
  dataScale: optionalLength,
  isNullable: z.boolean().default(true),
  defaultVal: optionalText(200),
  colComment: optionalText(COMMENT_MAX_LENGTH),
  domainId: optionalId,
  codeClsId: optionalId,
  defaultColId: optionalId,
  matchType: z.enum(MATCH_TYPES).default('MANUAL'),
});
export type ColumnInput = z.infer<typeof columnInputSchema>;

export const tableHeaderSchema = z.object({
  bizAreaId: idSchema,
  tableNm: text(100),
  tableLogicalNm: text(200, 1),
  description: optionalText(4000),
});

const columnsSchema = z.array(columnInputSchema).max(1000);

/** POST P/tables(version 없음). */
export const tableCreateSchema = z.object({ table: tableHeaderSchema, columns: columnsSchema });
export type TableCreateInput = z.infer<typeof tableCreateSchema>;

/** PUT P/tables/{id}(낙관적 잠금 version 필수, §8.1). */
export const tableSaveSchema = tableCreateSchema.extend({ version: z.int().positive() });
export type TableSaveInput = z.infer<typeof tableSaveSchema>;

/** POST P/tables/validate — 저장 본문과 같다(version 선택). */
export const tableValidateSchema = tableCreateSchema.extend({
  version: z.int().positive().optional(),
});

export const tableStatusSchema = z.object({
  status: z.enum(TABLE_STATUSES),
  version: z.int().positive(),
  note: optionalText(500),
});

export const tableCloneSchema = z.object({
  targetProjectKey: projectKeySchema.optional(),
  targetBizAreaId: idSchema.optional(),
  tableNm: text(100).optional(),
});

export const suggestNameSchema = z.object({ logicalNm: text(200, 1), bizAreaId: idSchema });

export const historyRestoreSchema = z.object({ version: z.int().positive() });
