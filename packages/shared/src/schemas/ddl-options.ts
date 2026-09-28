import { z } from 'zod';
import { DDL_OUTPUT_KINDS, DIALECTS } from '../enums.js';
import { DDL_EXPORT_TABLES_MAX } from '../limits.js';
import { IDENTIFIER_RE } from '../validation/identifier.js';
import { idSchema } from './common.js';

/** DDL 옵션(§6.7). 생략한 값은 기본값. */
export const ddlOptionsSchema = z.object({
  schemaName: z.string().regex(IDENTIFIER_RE).max(63).nullable().default(null),
  dropIfExists: z.boolean().default(false),
  includeComments: z.boolean().default(true),
  identifierCase: z.enum(['UPPER', 'LOWER']).default('UPPER'),
  quoteIdentifiers: z.boolean().default(false),
  codeColumnStyle: z.enum(['COMMENT_SUMMARY', 'CHECK', 'NONE']).default('COMMENT_SUMMARY'),
  fileSplit: z.enum(['SINGLE', 'PER_TABLE']).default('SINGLE'),
  lineEnding: z.enum(['LF', 'CRLF']).default('LF'),
  includeHeader: z.boolean().default(true),
  oracleCompat: z.enum(['12.1', '19c', '23ai']).default('19c'),
  mysqlTableOptions: z.string().max(200).default('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'),
});
export type DdlOptions = z.infer<typeof ddlOptionsSchema>;

/** POST P/ddl — 테이블 ID 또는 업무구분 ID 중 하나 이상(§6.10, 1회 200테이블). */
export const ddlRequestSchema = z
  .object({
    tableIds: z.array(idSchema).max(DDL_EXPORT_TABLES_MAX).optional(),
    bizAreaIds: z.array(idSchema).max(100).optional(),
    dialect: z.enum(DIALECTS),
    output: z.enum(['JSON', 'SQL', 'ZIP']).default('JSON'),
    options: ddlOptionsSchema.default(ddlOptionsSchema.parse({})),
    draft: z.boolean().optional(),
  })
  .refine((v) => (v.tableIds?.length ?? 0) + (v.bizAreaIds?.length ?? 0) > 0, {
    message: 'tableIds 또는 bizAreaIds가 필요합니다',
    path: ['tableIds'],
  });
export type DdlRequest = z.infer<typeof ddlRequestSchema>;

/** POST P/export-logs(복사 기록). */
export const exportLogSchema = z.object({
  kind: z.enum(DDL_OUTPUT_KINDS),
  tableIds: z.array(idSchema).min(1).max(DDL_EXPORT_TABLES_MAX),
  dialect: z.enum(DIALECTS),
  options: ddlOptionsSchema.default(ddlOptionsSchema.parse({})),
});
