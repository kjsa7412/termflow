import { inArray } from 'drizzle-orm';
import {
  API_ERROR_CODES,
  COPY_WARNING_CODES,
  type CopyOperation,
  type CopySourceKind,
  type Dialect,
  type MemberRole,
  type ProjectImports,
  type ProjectKind,
  type ProjectStatus,
  type StdEntityType,
  type ValidationIssue,
} from '@termflow/shared';
import { ValidationProblem } from '../../common/problem/problem.exception.js';
import type { SelectExecutor } from '../../autocomplete/l1-snapshot.js';
import { tfProject } from '../../db/schema.js';

/**
 * 복사 계획(설계서 §4.4 `CopyPlan`). 마법사 본문(§9.5 imports)·템플릿 게시(§4.6)·승계 COPY_TO_RMS(§11.1 step 9)가
 * 모두 이 형태로 엔진을 부른다.
 */
export const COPY_ITEM_KEYS = [
  'bizAreas',
  'terms',
  'domainClasses',
  'domains',
  'codes',
  'defaultColSets',
] as const;
export type CopyItemKey = (typeof COPY_ITEM_KEYS)[number];

/** 항목 키 → 로그 항목(project_copy_log.item). 코드·기본컬럼은 두 행(구분·코드 / 세트·구성)으로 기록한다. */
export const ITEM_ENTITIES: Record<CopyItemKey, StdEntityType[]> = {
  bizAreas: ['BIZ_AREA'],
  terms: ['TERM'],
  domainClasses: ['DOMAIN_CLS'],
  domains: ['DOMAIN'],
  codes: ['CODE_CLS', 'CODE'],
  defaultColSets: ['DEFAULT_COL_SET', 'DEFAULT_COL'],
};
export const ENTITY_ORDER: StdEntityType[] = [
  'BIZ_AREA',
  'TERM',
  'DOMAIN_CLS',
  'DOMAIN',
  'CODE_CLS',
  'CODE',
  'DEFAULT_COL_SET',
  'DEFAULT_COL',
];
export const ENTITY_ITEM_KEY: Record<StdEntityType, CopyItemKey> = {
  BIZ_AREA: 'bizAreas',
  TERM: 'terms',
  DOMAIN_CLS: 'domainClasses',
  DOMAIN: 'domains',
  CODE_CLS: 'codes',
  CODE: 'codes',
  DEFAULT_COL_SET: 'defaultColSets',
  DEFAULT_COL: 'defaultColSets',
};

export interface CopySource {
  kind: CopySourceKind;
  projectId: number | null;
  key: string | null;
}

export const EMPTY_SOURCE: CopySource = { kind: 'EMPTY', projectId: null, key: null };

export interface CopyTarget {
  projectKey: string;
  projectNm: string;
  description: string | null;
  kind: ProjectKind;
  defaultDialect: Dialect;
}

export interface CopyPlan {
  operation: CopyOperation;
  target: CopyTarget;
  sources: Record<CopyItemKey, CopySource>;
  /** 업무구분 원본에서 가져올 코드. null이면 전부. */
  bizCds: string[] | null;
  /** 용어: 승인(APPROVED)만. */
  approvedOnly: boolean;
  /** 생성자(프로젝트 관리자로 자동 등록). null이면 멤버 없음(템플릿 게시). */
  creatorUserId: number | null;
  members: { userId: number; role: MemberRole }[];
  /** 계획 단계에서 생긴 경고(C4 코드 비움 등). */
  warnings: ValidationIssue[];
}

export function sameSource(a: CopySource, b: CopySource): boolean {
  return a.kind === b.kind && a.projectId === b.projectId;
}

/** C3(§4.3): 도메인이 있고, 용어·도메인분류·도메인 원본이 모두 같지 않으면 재검증. */
export function needsC3(s: Record<CopyItemKey, CopySource>): boolean {
  if (s.domains.kind === 'EMPTY') return false;
  return !(sameSource(s.terms, s.domains) && sameSource(s.domainClasses, s.domains));
}

/** 대표 원본(tf_project.copied_from_project_id, §3.5.2): 용어 → 업무구분 → 나머지 순으로 처음 나오는 원본. */
export function representativeSource(s: Record<CopyItemKey, CopySource>): number | null {
  for (const k of [
    'terms',
    'bizAreas',
    'domainClasses',
    'domains',
    'codes',
    'defaultColSets',
  ] as const) {
    if (s[k].projectId !== null) return s[k].projectId;
  }
  return null;
}

interface SourceRow {
  id: number;
  key: string;
  kind: ProjectKind;
  status: ProjectStatus;
}

/**
 * 마법사 imports(§9.5) → 원본 ID. 규칙(§4.3):
 *  - TEMPLATE: kind=TEMPLATE AND status=ACTIVE
 *  - PROJECT: kind=PROJECT(보관 포함 — 가져오기 원본으로는 사용 가능, §4.7)
 *  - 업무구분 = 비움이면 코드도 비움(C4) + 경고
 * 위반은 422 `E_COPY_SOURCE_INVALID`(field = imports.{항목}.sourceKey).
 */
export async function resolveImports(
  q: SelectExecutor,
  imports: ProjectImports,
): Promise<Pick<CopyPlan, 'sources' | 'bizCds' | 'approvedOnly' | 'warnings'>> {
  const keys = [
    ...new Set(
      COPY_ITEM_KEYS.map((k) => imports[k].sourceKey).filter((v): v is string => Boolean(v)),
    ),
  ];
  const rows: SourceRow[] =
    keys.length === 0
      ? []
      : (
          await q
            .select({
              id: tfProject.projectId,
              key: tfProject.projectKey,
              kind: tfProject.kind,
              status: tfProject.status,
            })
            .from(tfProject)
            .where(inArray(tfProject.projectKey, keys))
        ).map((r) => ({ ...r, kind: r.kind as ProjectKind, status: r.status as ProjectStatus }));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const sources = {} as Record<CopyItemKey, CopySource>;
  for (const k of COPY_ITEM_KEYS) {
    const cfg = imports[k];
    if (cfg.source === 'EMPTY') {
      sources[k] = EMPTY_SOURCE;
      continue;
    }
    const row = cfg.sourceKey ? byKey.get(cfg.sourceKey) : undefined;
    const ok =
      row !== undefined &&
      (cfg.source === 'TEMPLATE'
        ? row.kind === 'TEMPLATE' && row.status === 'ACTIVE'
        : row.kind === 'PROJECT');
    if (!ok) {
      errors.push({
        code: 'E_COPY_SOURCE_INVALID',
        target: 'field',
        field: `imports.${k}.sourceKey`,
        message: `${API_ERROR_CODES.E_COPY_SOURCE_INVALID}: ${cfg.sourceKey ?? '(없음)'}`,
      });
      continue;
    }
    sources[k] = { kind: cfg.source, projectId: row.id, key: row.key };
  }
  if (errors.length > 0) throw new ValidationProblem(errors);
  if (sources.bizAreas.kind === 'EMPTY' && sources.codes.kind !== 'EMPTY') {
    sources.codes = EMPTY_SOURCE;
    warnings.push({
      code: 'W_COPY_CODES_EMPTIED',
      message: COPY_WARNING_CODES.W_COPY_CODES_EMPTIED,
    });
  }
  const bizCds = imports.bizAreas.bizCds ? [...new Set(imports.bizAreas.bizCds)] : null;
  return { sources, bizCds, approvedOnly: imports.terms.approvedOnly, warnings };
}
