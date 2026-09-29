import { z } from 'zod';
import { AUDIT_ACTIONS, STD_ENTITY_TYPES } from '../enums.js';
import { boolQuery, pageQuerySchema, text } from './common.js';

// ── 감사 로그·검색·일괄 등록(§8.5, §9.3, §9.4) ─────────────────────────────
const dateQuery = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();

export const auditLogQuerySchema = pageQuerySchema.extend({
  entityType: z.enum(STD_ENTITY_TYPES).optional(),
  entityId: z.coerce.number().int().positive().optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  actor: z.string().trim().max(50).optional(),
  batchId: z.string().trim().max(36).optional(),
  /** 날짜(포함, 서버 로컬). */
  from: dateQuery,
  to: dateQuery,
});
export type AuditLogQuery = z.output<typeof auditLogQuerySchema>;

export const searchQuerySchema = z.object({ q: text(100, 1) });

/** 일괄 등록 종류(§9.4 표). 기본컬럼은 세트 화면에서 직접 편집한다(일괄 등록 대상 아님). */
export const IMPORT_KINDS = [
  'biz-areas',
  'terms',
  'domain-classes',
  'domains',
  'code-classes',
] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];
export const importKindSchema = z.enum(IMPORT_KINDS);

export const IMPORT_ROW_STATUSES = ['NEW', 'UPDATE', 'SKIP', 'ERROR'] as const;
export type ImportRowStatus = (typeof IMPORT_ROW_STATUSES)[number];

export const importPreviewQuerySchema = pageQuerySchema.extend({
  status: z.enum(IMPORT_ROW_STATUSES).optional(),
  /** 경고가 있는 행만. */
  warn: boolQuery,
});
export const importApplySchema = z.object({ skipErrors: z.boolean().default(true) });
