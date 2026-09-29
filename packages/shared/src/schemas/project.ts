import { z } from 'zod';
import { DIALECTS, PROJECT_STATUSES } from '../enums.js';
import { BIZ_CD_RE } from '../validation/identifier.js';
import { boolQuery, idSchema, optionalText, projectKeySchema, text } from './common.js';
import { memberInputSchema } from './member.js';

/**
 * 프로젝트 생성(§9.5, CR-01 §4) — 항목별 원본(TEMPLATE/PROJECT/EMPTY). EMPTY가 아니면 sourceKey 필수.
 */
const importSource = z.enum(['TEMPLATE', 'PROJECT', 'EMPTY']);

const importBase = z.object({ source: importSource, sourceKey: projectKeySchema.optional() });

export const projectImportsSchema = z
  .object({
    bizAreas: importBase.extend({ bizCds: z.array(z.string().regex(BIZ_CD_RE)).optional() }),
    terms: importBase.extend({ approvedOnly: z.boolean().default(true) }),
    domainClasses: importBase,
    domains: importBase,
    codes: importBase,
    defaultColSets: importBase,
  })
  .superRefine((v, ctx) => {
    for (const [item, cfg] of Object.entries(v)) {
      if (cfg.source !== 'EMPTY' && cfg.sourceKey === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [item, 'sourceKey'],
          message: 'EMPTY가 아니면 sourceKey가 필요합니다',
        });
      }
    }
  });
export type ProjectImports = z.infer<typeof projectImportsSchema>;

export const projectCreateSchema = z.object({
  projectKey: projectKeySchema,
  projectNm: text(100, 1),
  description: optionalText(4000),
  defaultDialect: z.enum(DIALECTS).default('POSTGRESQL'),
  imports: projectImportsSchema,
  members: z.array(memberInputSchema).max(200).default([]),
});
export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;

/** POST /projects/copy-preview — 생성 본문의 imports만. */
export const copyPreviewSchema = z.object({ imports: projectImportsSchema });

/** PUT P/settings(키는 변경 불가). */
export const projectSettingsSchema = z.object({
  projectNm: text(100, 1),
  description: optionalText(4000),
  defaultDialect: z.enum(DIALECTS),
  includeDefaultCols: z.boolean(),
  defaultColSetId: idSchema.nullable(),
});

export const projectStatusSchema = z.object({ status: z.enum(PROJECT_STATUSES) });
export const confirmKeySchema = z.object({ confirmKey: projectKeySchema });

/** POST /admin/templates(게시, §4.6). */
export const templatePublishSchema = z.object({
  sourceProjectKey: projectKeySchema,
  projectKey: projectKeySchema,
  projectNm: text(100, 1),
  description: optionalText(4000),
  approvedOnly: z.boolean().default(true),
});

/** GET /projects?q&status&includeArchived&mine (§9.3). */
export const projectListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  includeArchived: boolQuery,
  /** 시스템 관리자도 멤버인 프로젝트만(목업 02 '내 프로젝트'). */
  mine: boolQuery,
});

/** GET /projects/check-key?key= — 형식은 서비스가 판정해 `{available:false, reason}`으로 돌려준다. */
export const checkKeyQuerySchema = z.object({ key: z.string().trim().max(20).default('') });

/** GET /admin/projects?status&q. */
export const adminProjectQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
});

/** GET P/member-candidates?q= */
export const memberCandidateQuerySchema = z.object({ q: z.string().trim().max(50).default('') });
