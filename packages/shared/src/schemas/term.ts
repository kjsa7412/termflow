import { z } from 'zod';
import { TERM_STATUSES } from '../enums.js';
import { TERM_PHYSICAL_RE } from '../validation/identifier.js';
import {
  boolQuery,
  idSchema,
  optionalText,
  pageQuerySchema,
  sortQuerySchema,
  text,
} from './common.js';

// ── 용어(§4.5, §5.4 인라인 등록) ────────────────────────────────────────────
const termPhysical = z.string().trim().regex(TERM_PHYSICAL_RE).max(30);
/**
 * 표준 사전 API의 한글 용어·물리약어는 **형식 검사를 서비스가 한다**(422 `E_TERM_*`, T6.2 DoD "물리약어 형식 422").
 * 스키마는 타입·최대 길이만 본다 — 엑셀 행 검증과 같은 함수(`validateTermFields`)를 쓰기 위해서다.
 */
const looseKor = z.string().max(200);
const loosePhysical = z.string().max(100).nullable().default(null);

export const termInputSchema = z.object({
  termKor: looseKor,
  termPhysical: loosePhysical,
  description: optionalText(500),
  synonymRef: optionalText(200),
});
export type TermInput = z.infer<typeof termInputSchema>;

/** POST P/standards/terms/inline — PENDING으로 등록(§5.4, T9.6). */
export const termInlineSchema = z.object({
  termKor: text(100, 1),
  termPhysical,
  description: optionalText(500),
});
export type TermInlineInput = z.infer<typeof termInlineSchema>;

/** 승인(정정 포함): 물리약어·설명을 바꿔 승인할 수 있다(§4.5 PENDING → APPROVED). */
export const termApproveSchema = z.object({
  termPhysical: z.string().max(100).optional(),
  description: optionalText(500).optional(),
});
export const termRejectSchema = z.object({ note: text(500, 1) });
export const termApproveBatchSchema = z.object({ termIds: z.array(idSchema).min(1).max(200) });

export const termListQuerySchema = pageQuerySchema.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(TERM_STATUSES).optional(),
  review: boolQuery,
  /** 물리약어를 다른 용어와 공유하는 용어만(R8·동의어 그룹). */
  shared: boolQuery,
  sort: sortQuerySchema,
});
export type TermListQuery = z.output<typeof termListQuerySchema>;

export const termCheckQuerySchema = z.object({
  termKor: z.string().max(200).optional(),
  termPhysical: z.string().max(100).optional(),
  /** 수정 중인 용어(자기 자신은 중복·공유 판정에서 뺀다). */
  exceptId: z.coerce.number().int().positive().optional(),
});

export const approvalListQuerySchema = pageQuerySchema.extend({
  /** PENDING(기본) · PROCESSED(승인·반려 처리 완료, 최근 처리순). */
  state: z.enum(['PENDING', 'PROCESSED']).default('PENDING'),
});
