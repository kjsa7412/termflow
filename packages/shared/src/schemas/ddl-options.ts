import { z } from 'zod';
import { DIALECTS, TABLE_STATUSES } from '../enums.js';
import { DDL_EXPORT_TABLES_MAX } from '../limits.js';
import { IDENTIFIER_RE } from '../validation/identifier.js';
import { boolQuery, idSchema, pageQuerySchema, sortQuerySchema } from './common.js';
import { tableValidateSchema } from './table.js';

/**
 * 스키마명(§6.7 "문자열(식별자 검증)"). 입력은 대소문자 무관(화면 예시 `rp`) → 대문자로 저장 규칙과 맞춘 뒤 식별자 정규식 검사.
 * 출력 대소문자는 `identifierCase`가 정한다. 빈 문자열은 없음(null).
 */
const schemaNameSchema = z
  .union([z.string(), z.null()])
  .default(null)
  .transform((v) => (v === null || v.trim() === '' ? null : v.trim().toUpperCase()))
  .pipe(z.string().regex(IDENTIFIER_RE).max(63).nullable());

/** DDL 옵션(§6.7, D14·D15 기본값). 생략한 값은 기본값. */
export const ddlOptionsSchema = z.object({
  schemaName: schemaNameSchema,
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
export type DdlOptions = z.output<typeof ddlOptionsSchema>;
export type DdlOptionsInput = z.input<typeof ddlOptionsSchema>;
/** 기본 옵션(D15: 대문자·스키마명 없음·DROP 미포함·코멘트 포함·비인용, D14: 코멘트 요약). */
export const DDL_OPTIONS_DEFAULT: DdlOptions = ddlOptionsSchema.parse({});
export type CodeColumnStyle = DdlOptions['codeColumnStyle'];

/**
 * 테이블 선택(§6.10): `tableIds`(사용자 정렬 순서 유지) 또는 `bizAreaIds`(업무구분 sort_no → 물리명), 1회 200테이블.
 * `draft`는 편집기 미리보기(저장 전 본문, §10.4) — 있으면 테이블 ID 없이 본문 1건으로 생성한다.
 */
const selectionShape = {
  tableIds: z.array(idSchema).max(DDL_EXPORT_TABLES_MAX).optional(),
  bizAreaIds: z.array(idSchema).max(100).optional(),
  /** 생략 시 프로젝트 기본 방언(`tf_project.default_dialect`). */
  dialect: z.enum(DIALECTS).optional(),
  options: ddlOptionsSchema.default(DDL_OPTIONS_DEFAULT),
};
const hasSelection = (v: { tableIds?: number[]; bizAreaIds?: number[]; draft?: unknown }) =>
  (v.tableIds?.length ?? 0) + (v.bizAreaIds?.length ?? 0) > 0 || v.draft !== undefined;
const selectionMessage = {
  message: 'tableIds · bizAreaIds · draft 중 하나가 필요합니다',
  path: ['tableIds'],
};

/** POST P/ddl — output JSON(미리보기, 기록 없음) / SQL(단일 .sql 다운로드) / ZIP(테이블별 파일 + `_warnings.txt`). */
export const ddlRequestSchema = z
  .object({
    ...selectionShape,
    output: z.enum(['JSON', 'SQL', 'ZIP']).default('JSON'),
    draft: tableValidateSchema.optional(),
  })
  .refine(hasSelection, selectionMessage);
export type DdlRequest = z.output<typeof ddlRequestSchema>;

/** POST P/ddl/extract — output JSON(미리보기 텍스트, 기록 없음) / TSV(다운로드, EXTRACT 기록), §6.11. */
export const ddlExtractRequestSchema = z
  .object({ ...selectionShape, output: z.enum(['JSON', 'TSV']).default('JSON') })
  .refine(hasSelection, selectionMessage);
export type DdlExtractRequest = z.output<typeof ddlExtractRequestSchema>;

/** GET P/tables/{id}/ddl?dialect&…(§9.3) — 옵션은 쿼리 문자열, `format=json`이면 JSON(DdlResponse), 기본 text/plain. */
export const tableDdlQuerySchema = z.object({
  dialect: z.enum(DIALECTS).optional(),
  schemaName: z.string().max(63).optional(),
  dropIfExists: boolQuery,
  includeComments: boolQuery,
  identifierCase: z.enum(['UPPER', 'LOWER']).optional(),
  quoteIdentifiers: boolQuery,
  codeColumnStyle: z.enum(['COMMENT_SUMMARY', 'CHECK', 'NONE']).optional(),
  lineEnding: z.enum(['LF', 'CRLF']).optional(),
  includeHeader: boolQuery,
  format: z.enum(['text', 'json']).default('text'),
});
export type TableDdlQuery = z.output<typeof tableDdlQuerySchema>;

/**
 * POST P/export-logs — 화면에서 복사한 기록(§6.10). 다운로드(DOWNLOAD·ZIP)와 정보 추출 다운로드(EXTRACT)는
 * 서버가 생성하면서 직접 기록하므로, 클라이언트가 남기는 종류는 복사(COPY: DDL, EXTRACT: 탭 구분 텍스트 복사)뿐이다.
 */
export const exportLogSchema = z.object({
  kind: z.enum(['COPY', 'EXTRACT']),
  tableIds: z.array(idSchema).min(1).max(DDL_EXPORT_TABLES_MAX),
  dialect: z.enum(DIALECTS).optional(),
  options: ddlOptionsSchema.default(DDL_OPTIONS_DEFAULT),
  warningCnt: z.int().min(0).max(32_767).default(0),
});
export type ExportLogInput = z.output<typeof exportLogSchema>;

export const exportLogQuerySchema = pageQuerySchema;

/** GET P/tables(§9.3): 업무구분·검색·상태·정렬·페이지. */
export const tableListQuerySchema = pageQuerySchema.extend({
  bizAreaId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(100).optional(),
  status: z.enum(TABLE_STATUSES).optional(),
  sort: sortQuerySchema,
});
export type TableListQuery = z.output<typeof tableListQuerySchema>;
