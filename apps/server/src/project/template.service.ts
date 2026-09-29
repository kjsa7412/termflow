import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import {
  API_ERROR_CODES,
  type ProjectCreateResponse,
  type ProjectKind,
  type ProjectStatus,
  type TemplateItem,
} from '@termflow/shared';
import type { Audit } from '../common/audit/audit.js';
import { ConflictProblem, NotFoundProblem } from '../common/problem/problem.exception.js';
import type { Db } from '../db/client.js';
import { DRIZZLE } from '../db/db.module.js';
import { tfProject } from '../db/schema.js';
import type { CopyPlan, CopySource } from './copy/copy-plan.js';
import { ProjectCopyService } from './copy/project-copy.service.js';
import { assertConfirmKey, ProjectService } from './project.service.js';
import { isoTs, rowsOf, stdCountsOf } from './sql-util.js';

/**
 * 템플릿 관리(T5.8, 설계서 §4.6). 템플릿 = kind TEMPLATE 프로젝트. 게시는 복사 엔진을 "모든 항목 원본 = 해당 프로젝트,
 * operation PUBLISH"로 실행한다(원본 변경 없음). 사용 중(파생 프로젝트 ≥ 1)이면 삭제 불가 → 409 `E_TEMPLATE_IN_USE`.
 */
@Injectable()
export class TemplateService {
  private readonly logger = new Logger('Templates');

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly copy: ProjectCopyService,
    private readonly projects: ProjectService,
  ) {}

  /** 파생 판정(§4.6): project_copy_log.source_project_id 또는 tf_project.copied_from_project_id가 가리킴. */
  private derivedSql(idCol: ReturnType<typeof sql>) {
    return sql`(select count(distinct x.pid) from (
               select l.project_id pid from project_copy_log l where l.source_project_id = ${idCol} and l.project_id <> ${idCol}
               union select d.project_id from tf_project d where d.copied_from_project_id = ${idCol} and d.project_id <> ${idCol}
             ) x)::int`;
  }

  async list(): Promise<TemplateItem[]> {
    const rows = await rowsOf<{
      id: number;
      key: string;
      nm: string;
      description: string | null;
      status: ProjectStatus;
      derived: number;
      from_key: string | null;
      from_nm: string | null;
      created_at: string;
      created_by: string;
    }>(
      this.db,
      sql`select p.project_id id, p.project_key key, p.project_nm nm, p.description, p.status,
                 ${this.derivedSql(sql`p.project_id`)} derived,
                 f.project_key from_key, f.project_nm from_nm, ${isoTs(sql`p.created_at`)} created_at, p.created_by
            from tf_project p left join tf_project f on f.project_id = p.copied_from_project_id
           where p.kind = 'TEMPLATE' order by p.status, p.project_key`,
    );
    const counts = await stdCountsOf(
      this.db,
      rows.map((r) => r.id),
    );
    return rows.map((r) => ({
      key: r.key,
      nm: r.nm,
      description: r.description,
      status: r.status,
      counts: counts.get(r.id)!,
      derivedCnt: r.derived,
      publishedFrom: r.from_key ? { key: r.from_key, nm: r.from_nm! } : null,
      createdAt: r.created_at,
      createdBy: r.created_by,
    }));
  }

  /** 게시(P1): 원본 프로젝트(또는 템플릿)의 업무구분·표준 사전 전체를 새 템플릿으로 스냅샷 복사. */
  async publish(
    input: {
      sourceProjectKey: string;
      projectKey: string;
      projectNm: string;
      description: string | null;
      approvedOnly: boolean;
    },
    a: Audit,
  ): Promise<ProjectCreateResponse> {
    const [src] = await this.db
      .select({ id: tfProject.projectId, key: tfProject.projectKey, kind: tfProject.kind })
      .from(tfProject)
      .where(eq(tfProject.projectKey, input.sourceProjectKey));
    if (!src) throw new NotFoundProblem('원본 프로젝트를 찾을 수 없습니다');
    const check = await this.projects.checkKey(input.projectKey);
    if (!check.available)
      throw new ConflictProblem(
        'E_PROJECT_KEY_DUP',
        check.reason ?? API_ERROR_CODES.E_PROJECT_KEY_DUP,
      );
    const source: CopySource = {
      kind: (src.kind as ProjectKind) === 'TEMPLATE' ? 'TEMPLATE' : 'PROJECT',
      projectId: src.id,
      key: src.key,
    };
    const plan: CopyPlan = {
      operation: 'PUBLISH',
      target: {
        projectKey: input.projectKey,
        projectNm: input.projectNm,
        description: input.description,
        kind: 'TEMPLATE',
        defaultDialect: 'POSTGRESQL',
      },
      sources: {
        bizAreas: source,
        terms: source,
        domainClasses: source,
        domains: source,
        codes: source,
        defaultColSets: source,
      },
      bizCds: null,
      approvedOnly: input.approvedOnly,
      creatorUserId: null,
      members: [],
      warnings: [],
    };
    const { c3: _c3, ...out } = await this.copy.execute(plan, a);
    this.logger.log(
      `템플릿 게시: ${input.projectKey} ← ${src.key} by ${a.actor} (${out.elapsedMs}ms)`,
    );
    return out;
  }

  async delete(key: string, confirmKey: string, a: Audit): Promise<void> {
    const t = await this.projects.findByKey(key, 'TEMPLATE');
    assertConfirmKey(key, confirmKey);
    const [r] = await rowsOf<{ n: number }>(
      this.db,
      sql`select ${this.derivedSql(sql`${t.id}`)} n`,
    );
    if ((r?.n ?? 0) > 0) {
      throw new ConflictProblem(
        'E_TEMPLATE_IN_USE',
        `${API_ERROR_CODES.E_TEMPLATE_IN_USE}(파생 ${r!.n}개) — 보관만 할 수 있습니다`,
        { derivedCnt: r!.n },
      );
    }
    await this.db.delete(tfProject).where(eq(tfProject.projectId, t.id));
    this.logger.warn(`템플릿 삭제: ${key} by ${a.actor}`);
  }
}
