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

/**
 * 테이블 헤더. `bizAreaId`는 형식상 선택(null)이고 필수 판정은 업무 검증 422 `E_BIZ_AREA_REQUIRED`(§8.4, CR-07 C2) —
 * 400이면 편집기가 행 단위 오류와 같은 경로로 보여 줄 수 없다.
 */
export const tableHeaderSchema = z.object({
  bizAreaId: optionalId,
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

/** POST P/tables/validate — 저장 본문과 같다(version 선택, `tableId` = 자기 자신 — E_TABLE_NM_DUP 판정에서 제외). */
export const tableValidateSchema = tableCreateSchema.extend({
  version: z.int().positive().optional(),
  tableId: idSchema.optional(),
});
export type TableValidateInput = z.infer<typeof tableValidateSchema>;

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

/** POST P/tables/suggest-name(§5.5). `tableId` = 편집 중 테이블(E_TABLE_NM_DUP 판정에서 제외). */
export const suggestNameSchema = z.object({
  logicalNm: text(200, 1),
  bizAreaId: idSchema.nullable().default(null),
  tableId: idSchema.optional(),
});
export type SuggestNameInput = z.infer<typeof suggestNameSchema>;

export const historyRestoreSchema = z.object({ version: z.int().positive() });
