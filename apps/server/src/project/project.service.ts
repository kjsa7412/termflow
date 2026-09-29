import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  API_ERROR_CODES,
  PROJECT_KEY_RE,
  type AdminProjectItem,
  type CopyLogItem,
  type CopyPreviewResponse,
  type CopySourceItem,
  type CopySourcesResponse,
  type Dialect,
  type MemberRole,
  type ProjectCard,
  type ProjectCreateInput,
  type ProjectCreateResponse,
  type ProjectHome,
  type ProjectImports,
  type ProjectKind,
  type ProjectSettings,
  type ProjectStatus,
  type StdEntityType,
  type CopySourceKind,
  type ValidationIssue,
} from '@termflow/shared';
import type { AuthUser } from '../auth/session-user.js';
import type { Audit } from '../common/audit/audit.js';
import {
  ConflictProblem,
  NotFoundProblem,
  ValidationProblem,
} from '../common/problem/problem.exception.js';
import type { ProjectCtx } from '../common/project-context.js';
import { updateAudited } from '../db/audit.js';
import type { Db } from '../db/client.js';
import { DRIZZLE } from '../db/db.module.js';
import { stdDefaultColSet, tfProject } from '../db/schema.js';
import { typeText } from '../standard/std-type-parser.js';
import { resolveImports, type CopyPlan } from './copy/copy-plan.js';
import { ProjectCopyService } from './copy/project-copy.service.js';
import { isoTs, likePattern, rowsOf, stdCountsOf } from './sql-util.js';

export interface ProjectListQuery {
  q?: string | undefined;
  status?: ProjectStatus | undefined;
  includeArchived?: boolean | undefined;
  mine?: boolean | undefined;
}

/**
 * 프로젝트 API(T5.1·T5.4·T5.5, 설계서 §4.3·§4.7·§9.3). 생성·미리보기는 복사 엔진(ProjectCopyService)에 위임한다.
 */
@Injectable()
export class ProjectService {
  private readonly logger = new Logger('Projects');

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly copy: ProjectCopyService,
  ) {}

  // ── 목록·키 검사·원본 후보 ────────────────────────────────────────────
  /** 카드 목록: 소속만(시스템 관리자는 전체), 템플릿 제외, 보관은 기본 숨김(§4.7). */
  async list(user: AuthUser, query: ProjectListQuery): Promise<ProjectCard[]> {
    const sa = user.isSysAdmin;
    const showArchived = query.includeArchived === true || query.status === 'ARCHIVED';
    const rows = await rowsOf<{
      id: number;
      key: string;
      nm: string;
      description: string | null;
      status: ProjectStatus;
      dialect: Dialect;
      role: MemberRole | null;
      member_cnt: number;
      table_cnt: number;
      last_at: string | null;
      last_by: string | null;
    }>(
      this.db,
      sql`select p.project_id id, p.project_key key, p.project_nm nm, p.description, p.status, p.default_dialect dialect,
                 m.member_role role,
                 (select count(*) from tf_project_member x where x.project_id = p.project_id)::int member_cnt,
                 (select count(*) from prj_table t where t.project_id = p.project_id)::int table_cnt,
                 ${isoTs(sql`coalesce(lt.updated_at, p.updated_at)`)} last_at,
                 coalesce(lt.updated_by, p.updated_by) last_by
            from tf_project p
            left join tf_project_member m on m.project_id = p.project_id and m.user_id = ${user.id}
            left join lateral (select t.updated_at, t.updated_by from prj_table t where t.project_id = p.project_id
                                order by t.updated_at desc limit 1) lt on true
           where p.kind = 'PROJECT'
             and (${sa}::boolean or m.user_id is not null)
             and (not ${query.mine === true}::boolean or m.user_id is not null)
             and (${query.status ?? null}::text is null or p.status = ${query.status ?? null})
             and (${showArchived}::boolean or p.status = 'ACTIVE')
             and (${query.q ?? ''} = '' or p.project_key ilike ${likePattern(query.q ?? '')}
                  or p.project_nm ilike ${likePattern(query.q ?? '')})
           order by p.project_key`,
    );
    const biz = await this.bizChips(rows.map((r) => r.id));
    return rows.map((r) => ({
      key: r.key,
      nm: r.nm,
      description: r.description,
      myRole: r.role ?? 'ADMIN',
      isMember: r.role !== null,
      bizAreas: biz.get(r.id) ?? [],
      tableCnt: r.table_cnt,
      memberCnt: r.member_cnt,
      lastChangedAt: r.last_at,
      lastChangedBy: r.last_by,
      status: r.status,
      defaultDialect: r.dialect,
    }));
  }

  private async bizChips(ids: number[]) {
    const out = new Map<number, ProjectCard['bizAreas']>();
    if (ids.length === 0) return out;
    const rows = await rowsOf<{
      pid: number;
      biz_cd: string;
      biz_nm: string;
      use_yn: boolean;
      n: number;
    }>(
      this.db,
      sql`select b.project_id pid, b.biz_cd, b.biz_nm, b.use_yn,
                 (select count(*) from prj_table t where t.biz_area_id = b.biz_area_id)::int n
            from prj_biz_area b where b.project_id = any(${sql.param(ids)}::int[])
           order by b.sort_no, b.biz_cd`,
    );
    for (const r of rows) {
      const list = out.get(r.pid) ?? [];
      list.push({ bizCd: r.biz_cd, bizNm: r.biz_nm, tableCnt: r.n, useYn: r.use_yn });
      out.set(r.pid, list);
    }
    return out;
  }

  /** 키 즉시 검사(§4.3): 형식(`^[A-Z][A-Z0-9]{1,9}$`)·중복(템플릿 키 포함). */
  async checkKey(key: string): Promise<{ available: boolean; reason?: string }> {
    if (!PROJECT_KEY_RE.test(key)) {
      return {
        available: false,
        reason: '키는 영문 대문자로 시작하는 영문 대문자·숫자 2~10자입니다',
      };
    }
    const [row] = await this.db
      .select({ id: tfProject.projectId })
      .from(tfProject)
      .where(eq(tfProject.projectKey, key));
    return row
      ? { available: false, reason: API_ERROR_CODES.E_PROJECT_KEY_DUP }
      : { available: true };
  }

  /** 마법사 원본 후보(§4.3): 템플릿 = TEMPLATE·ACTIVE, 프로젝트 = 조회 가능한 프로젝트(SA 전체·보관 포함). */
  async copySources(user: AuthUser): Promise<CopySourcesResponse> {
    const rows = await rowsOf<{
      id: number;
      key: string;
      nm: string;
      kind: ProjectKind;
      status: ProjectStatus;
    }>(
      this.db,
      sql`select p.project_id id, p.project_key key, p.project_nm nm, p.kind, p.status
            from tf_project p
           where (p.kind = 'TEMPLATE' and p.status = 'ACTIVE')
              or (p.kind = 'PROJECT' and (${user.isSysAdmin}::boolean
                   or exists (select 1 from tf_project_member m where m.project_id = p.project_id and m.user_id = ${user.id})))
           order by p.kind desc, p.project_key`,
    );
    const ids = rows.map((r) => r.id);
    const counts = await stdCountsOf(this.db, ids);
    const biz = await rowsOf<{
      pid: number;
      biz_cd: string;
      biz_nm: string;
      cls: number;
      codes: number;
    }>(
      this.db,
      sql`select b.project_id pid, b.biz_cd, b.biz_nm,
                 (select count(*) from std_code_cls c where c.biz_area_id = b.biz_area_id)::int cls,
                 (select count(*) from std_code x join std_code_cls c on c.code_cls_id = x.code_cls_id
                   where c.biz_area_id = b.biz_area_id)::int codes
            from prj_biz_area b where b.project_id = any(${sql.param(ids.length ? ids : [0])}::int[])
           order by b.sort_no, b.biz_cd`,
    );
    const item = (r: (typeof rows)[number]): CopySourceItem => ({
      key: r.key,
      nm: r.nm,
      kind: r.kind,
      status: r.status,
      counts: counts.get(r.id)!,
      bizAreas: biz
        .filter((b) => b.pid === r.id)
        .map((b) => ({ bizCd: b.biz_cd, bizNm: b.biz_nm, codeClsCnt: b.cls, codeCnt: b.codes })),
    });
    return {
      templates: rows.filter((r) => r.kind === 'TEMPLATE').map(item),
      projects: rows.filter((r) => r.kind === 'PROJECT').map(item),
    };
  }

  // ── 미리보기·생성 ────────────────────────────────────────────────────
  private async plan(
    input: Pick<
      ProjectCreateInput,
      'projectKey' | 'projectNm' | 'description' | 'defaultDialect' | 'members'
    > & {
      imports: ProjectImports;
    },
    creatorUserId: number | null,
  ): Promise<CopyPlan> {
    const resolved = await resolveImports(this.db, input.imports);
    return {
      operation: 'CREATE',
      target: {
        projectKey: input.projectKey,
        projectNm: input.projectNm,
        description: input.description,
        kind: 'PROJECT',
        defaultDialect: input.defaultDialect,
      },
      ...resolved,
      creatorUserId,
      members: input.members,
    };
  }

  async preview(imports: ProjectImports): Promise<CopyPreviewResponse> {
    const plan = await this.plan(
      {
        projectKey: 'PREVIEW',
        projectNm: '',
        description: null,
        defaultDialect: 'POSTGRESQL',
        members: [],
        imports,
      },
      null,
    );
    return this.copy.preview(plan);
  }

  /** 생성(§4.3, CR-01 C5): 프로젝트 행·멤버·표준 복사가 한 트랜잭션. 키 중복 409, 원본 오류 422. */
  async create(
    input: ProjectCreateInput,
    user: AuthUser,
    a: Audit,
  ): Promise<ProjectCreateResponse> {
    const check = await this.checkKey(input.projectKey);
    if (!check.available && check.reason === API_ERROR_CODES.E_PROJECT_KEY_DUP)
      throw new ConflictProblem('E_PROJECT_KEY_DUP', API_ERROR_CODES.E_PROJECT_KEY_DUP);
    const plan = await this.plan(input, user.id);
    const out = await this.copy.execute(plan, a);
    this.logger.log(
      `프로젝트 생성: ${out.projectKey} by ${a.actor} — ${out.items
        .map((i) => `${i.item} ${i.copied}`)
        .join(
          ' · ',
        )} · C3 ${out.c3Revalidation.performed ? `표시 ${out.c3Revalidation.flaggedCnt}` : '생략'} · ${out.elapsedMs}ms`,
    );
    const { c3: _c3, ...response } = out;
    return response;
  }

  // ── 프로젝트 홈·설정·복사 기록 ───────────────────────────────────────
  async home(ctx: ProjectCtx): Promise<ProjectHome> {
    const pid = ctx.projectId;
    const [p] = await rowsOf<{
      key: string;
      nm: string;
      description: string | null;
      kind: ProjectKind;
      status: ProjectStatus;
      dialect: Dialect;
      include_default_cols: boolean;
      set_nm: string | null;
      from_key: string | null;
      from_nm: string | null;
      created_at: string;
      created_by: string;
      member_cnt: number;
      review_domain: number;
      pending_term: number;
    }>(
      this.db,
      sql`select p.project_key key, p.project_nm nm, p.description, p.kind, p.status, p.default_dialect dialect,
                 p.include_default_cols, s.set_nm, f.project_key from_key, f.project_nm from_nm,
                 ${isoTs(sql`p.created_at`)} created_at, p.created_by,
                 (select count(*) from tf_project_member m where m.project_id = p.project_id)::int member_cnt,
                 (select count(*) from std_domain d where d.project_id = p.project_id and d.review_yn)::int review_domain,
                 (select count(*) from std_term t where t.project_id = p.project_id and t.status = 'PENDING')::int pending_term
            from tf_project p
            left join std_default_col_set s on s.set_id = p.default_col_set_id
            left join tf_project f on f.project_id = p.copied_from_project_id
           where p.project_id = ${pid}`,
    );
    if (!p) throw new NotFoundProblem('프로젝트를 찾을 수 없습니다');
    const biz = await rowsOf<{
      id: number;
      biz_cd: string;
      biz_nm: string;
      table_prefix: string | null;
      use_yn: boolean;
      sort_no: number;
      n: number;
      draft: number;
      fin: number;
      review: number;
      last_at: string | null;
      last_by: string | null;
    }>(
      this.db,
      sql`select b.biz_area_id id, b.biz_cd, b.biz_nm, b.table_prefix, b.use_yn, b.sort_no,
                 count(t.table_id)::int n,
                 count(t.table_id) filter (where t.status = 'DRAFT')::int draft,
                 count(t.table_id) filter (where t.status = 'FINAL')::int fin,
                 count(t.table_id) filter (where t.review_yn)::int review,
                 ${isoTs(sql`max(t.updated_at)`)} last_at,
                 (array_agg(t.updated_by order by t.updated_at desc) filter (where t.table_id is not null))[1] last_by
            from prj_biz_area b left join prj_table t on t.biz_area_id = b.biz_area_id
           where b.project_id = ${pid}
           group by b.biz_area_id order by b.sort_no, b.biz_cd`,
    );
    const recent = await rowsOf<{
      table_id: number;
      table_nm: string;
      table_logical_nm: string;
      version: number;
      action: string;
      change_summary: string | null;
      saved_by: string;
      saved_at: string;
    }>(
      this.db,
      sql`select h.table_id, t.table_nm, t.table_logical_nm, h.version, h.action, h.change_summary, h.saved_by,
                 ${isoTs(sql`h.saved_at`)} saved_at
            from prj_table_history h join prj_table t on t.table_id = h.table_id
           where t.project_id = ${pid}
           order by h.saved_at desc, h.history_id desc limit 10`,
    );
    const sum = (f: (b: (typeof biz)[number]) => number) => biz.reduce((acc, b) => acc + f(b), 0);
    return {
      project: {
        key: p.key,
        nm: p.nm,
        description: p.description,
        kind: p.kind,
        status: p.status,
        defaultDialect: p.dialect,
        includeDefaultCols: p.include_default_cols,
        defaultColSetNm: p.set_nm,
        copiedFrom: p.from_key ? { key: p.from_key, nm: p.from_nm! } : null,
        createdAt: p.created_at,
        createdBy: p.created_by,
      },
      myRole: ctx.role,
      memberCnt: p.member_cnt,
      bizAreas: biz.map((b) => ({
        bizAreaId: b.id,
        bizCd: b.biz_cd,
        bizNm: b.biz_nm,
        tablePrefix: b.table_prefix,
        useYn: b.use_yn,
        sortNo: b.sort_no,
        tableCnt: b.n,
        draftCnt: b.draft,
        finalCnt: b.fin,
        reviewCnt: b.review,
        lastChangedAt: b.last_at,
        lastChangedBy: b.last_by,
      })),
      tables: {
        total: sum((b) => b.n),
        draft: sum((b) => b.draft),
        final: sum((b) => b.fin),
        review: sum((b) => b.review),
      },
      recentChanges: recent.map((r) => ({
        tableId: r.table_id,
        tableNm: r.table_nm,
        tableLogicalNm: r.table_logical_nm,
        version: r.version,
        action: r.action,
        changeSummary: r.change_summary,
        savedBy: r.saved_by,
        savedAt: r.saved_at,
      })),
      reviewDomainCnt: p.review_domain,
      pendingTermCnt: p.pending_term,
    };
  }

  async settings(ctx: ProjectCtx): Promise<ProjectSettings> {
    const [p] = await rowsOf<{
      key: string;
      nm: string;
      description: string | null;
      kind: ProjectKind;
      status: ProjectStatus;
      dialect: Dialect;
      include_default_cols: boolean;
      default_col_set_id: number | null;
      from_key: string | null;
      from_nm: string | null;
      created_at: string;
      created_by: string;
    }>(
      this.db,
      sql`select p.project_key key, p.project_nm nm, p.description, p.kind, p.status, p.default_dialect dialect,
                 p.include_default_cols, p.default_col_set_id, f.project_key from_key, f.project_nm from_nm,
                 ${isoTs(sql`p.created_at`)} created_at, p.created_by
            from tf_project p left join tf_project f on f.project_id = p.copied_from_project_id
           where p.project_id = ${ctx.projectId}`,
    );
    if (!p) throw new NotFoundProblem('프로젝트를 찾을 수 없습니다');
    const cols = await rowsOf<{
      set_id: number;
      set_nm: string;
      is_default: boolean;
      col_seq: number | null;
      logical_nm: string | null;
      physical_nm: string | null;
      data_type: string | null;
      data_length: number | null;
      data_scale: number | null;
      default_val: string | null;
      is_pk: boolean | null;
    }>(
      this.db,
      sql`select s.set_id, s.set_nm, s.is_default, c.col_seq, c.logical_nm, c.physical_nm, c.data_type, c.data_length,
                 c.data_scale, c.default_val, c.is_pk
            from std_default_col_set s left join std_default_col c on c.set_id = s.set_id
           where s.project_id = ${ctx.projectId}
           order by s.set_id, c.col_seq`,
    );
    const sets = new Map<number, ProjectSettings['defaultColSets'][number]>();
    for (const c of cols) {
      const set = sets.get(c.set_id) ?? {
        setId: c.set_id,
        setNm: c.set_nm,
        isDefault: c.is_default,
        columns: [],
      };
      if (c.col_seq !== null) {
        set.columns.push({
          colSeq: c.col_seq,
          logicalNm: c.logical_nm!,
          physicalNm: c.physical_nm!,
          typeText: typeText(c.data_type as never, c.data_length, c.data_scale),
          defaultVal: c.default_val,
          isPk: c.is_pk === true,
        });
      }
      sets.set(c.set_id, set);
    }
    return {
      projectKey: p.key,
      projectNm: p.nm,
      description: p.description,
      kind: p.kind,
      status: p.status,
      defaultDialect: p.dialect,
      includeDefaultCols: p.include_default_cols,
      defaultColSetId: p.default_col_set_id,
      defaultColSets: [...sets.values()],
      copiedFrom: p.from_key ? { key: p.from_key, nm: p.from_nm! } : null,
      createdAt: p.created_at,
      createdBy: p.created_by,
    };
  }

  /** PUT P/settings(§9.3): 키는 본문에 없다(변경 불가, §4.7). 기본컬럼 세트는 이 프로젝트 소속만. */
  async updateSettings(
    ctx: ProjectCtx,
    body: {
      projectNm: string;
      description: string | null;
      defaultDialect: Dialect;
      includeDefaultCols: boolean;
      defaultColSetId: number | null;
    },
    a: Audit,
  ): Promise<ProjectSettings> {
    if (body.defaultColSetId !== null) {
      const [s] = await this.db
        .select({ id: stdDefaultColSet.setId })
        .from(stdDefaultColSet)
        .where(
          and(
            eq(stdDefaultColSet.setId, body.defaultColSetId),
            eq(stdDefaultColSet.projectId, ctx.projectId),
          ),
        );
      if (!s) {
        throw new ValidationProblem([
          {
            code: 'E_DEFAULT_COL_SET_NOT_FOUND',
            target: 'field',
            field: 'defaultColSetId',
            message: API_ERROR_CODES.E_DEFAULT_COL_SET_NOT_FOUND,
          },
        ]);
      }
    }
    await updateAudited(this.db, tfProject, body, a).where(eq(tfProject.projectId, ctx.projectId));
    return this.settings(ctx);
  }

  async copyLog(ctx: ProjectCtx): Promise<CopyLogItem[]> {
    const rows = await rowsOf<{
      batch_id: string;
      operation: 'CREATE' | 'PUBLISH';
      item: StdEntityType;
      source_kind: CopySourceKind;
      source_key: string | null;
      options: Record<string, unknown>;
      source_cnt: number;
      copied_cnt: number;
      skipped_cnt: number;
      flagged_cnt: number;
      warnings: ValidationIssue[];
      elapsed_ms: number;
      copied_by: string;
      copied_at: string;
    }>(
      this.db,
      sql`select l.batch_id, l.operation, l.item, l.source_kind, s.project_key source_key, l.options, l.source_cnt,
                 l.copied_cnt, l.skipped_cnt, l.flagged_cnt, l.warnings, l.elapsed_ms, l.copied_by,
                 ${isoTs(sql`l.copied_at`)} copied_at
            from project_copy_log l left join tf_project s on s.project_id = l.source_project_id
           where l.project_id = ${ctx.projectId} order by l.copy_id`,
    );
    return rows.map((r) => ({
      batchId: r.batch_id,
      operation: r.operation,
      item: r.item,
      sourceKind: r.source_kind,
      sourceKey: r.source_key,
      options: r.options,
      sourceCnt: r.source_cnt,
      copiedCnt: r.copied_cnt,
      skippedCnt: r.skipped_cnt,
      flaggedCnt: r.flagged_cnt,
      warnings: r.warnings,
      elapsedMs: r.elapsed_ms,
      copiedBy: r.copied_by,
      copiedAt: r.copied_at,
    }));
  }

  // ── 시스템 › 프로젝트(/admin/projects, T5.5) ─────────────────────────
  async adminList(query: {
    q?: string | undefined;
    status?: ProjectStatus | undefined;
  }): Promise<AdminProjectItem[]> {
    const rows = await rowsOf<{
      key: string;
      nm: string;
      description: string | null;
      status: ProjectStatus;
      member_cnt: number;
      table_cnt: number;
      biz_cds: string[] | null;
      from_key: string | null;
      from_nm: string | null;
      last_at: string | null;
      created_at: string;
      created_by: string;
    }>(
      this.db,
      sql`select p.project_key key, p.project_nm nm, p.description, p.status,
                 (select count(*) from tf_project_member m where m.project_id = p.project_id)::int member_cnt,
                 (select count(*) from prj_table t where t.project_id = p.project_id)::int table_cnt,
                 (select array_agg(b.biz_cd order by b.sort_no, b.biz_cd) from prj_biz_area b where b.project_id = p.project_id) biz_cds,
                 f.project_key from_key, f.project_nm from_nm,
                 ${isoTs(sql`greatest(p.updated_at, (select max(t.updated_at) from prj_table t where t.project_id = p.project_id))`)} last_at,
                 ${isoTs(sql`p.created_at`)} created_at, p.created_by
            from tf_project p left join tf_project f on f.project_id = p.copied_from_project_id
           where p.kind = 'PROJECT'
             and (${query.status ?? null}::text is null or p.status = ${query.status ?? null})
             and (${query.q ?? ''} = '' or p.project_key ilike ${likePattern(query.q ?? '')}
                  or p.project_nm ilike ${likePattern(query.q ?? '')})
           order by p.status, p.project_key`,
    );
    return rows.map((r) => ({
      key: r.key,
      nm: r.nm,
      description: r.description,
      status: r.status,
      memberCnt: r.member_cnt,
      tableCnt: r.table_cnt,
      bizCds: r.biz_cds ?? [],
      copiedFrom: r.from_key ? { key: r.from_key, nm: r.from_nm! } : null,
      lastChangedAt: r.last_at,
      createdAt: r.created_at,
      createdBy: r.created_by,
    }));
  }

  /** kind가 맞는 프로젝트(템플릿 관리 API는 TEMPLATE, 프로젝트 관리 API는 PROJECT). 없으면 404. */
  async findByKey(
    key: string,
    kind: ProjectKind,
  ): Promise<{ id: number; key: string; nm: string; status: ProjectStatus }> {
    const [p] = await this.db
      .select({
        id: tfProject.projectId,
        key: tfProject.projectKey,
        nm: tfProject.projectNm,
        status: tfProject.status,
      })
      .from(tfProject)
      .where(and(eq(tfProject.projectKey, key), eq(tfProject.kind, kind)));
    if (!p)
      throw new NotFoundProblem(
        kind === 'TEMPLATE' ? '템플릿을 찾을 수 없습니다' : '프로젝트를 찾을 수 없습니다',
      );
    return { ...p, status: p.status as ProjectStatus };
  }

  /** 보관·복원(§4.7, 시스템 관리자). */
  async setStatus(key: string, kind: ProjectKind, status: ProjectStatus, a: Audit): Promise<void> {
    const p = await this.findByKey(key, kind);
    if (p.status === status) return;
    await updateAudited(this.db, tfProject, { status }, a).where(eq(tfProject.projectId, p.id));
    this.logger.log(
      `${kind === 'TEMPLATE' ? '템플릿' : '프로젝트'} ${status === 'ARCHIVED' ? '보관' : '복원'}: ${key} by ${a.actor}`,
    );
  }

  /**
   * 삭제(§4.7): 보관(ARCHIVED) 상태 + 키 재입력. `DELETE FROM tf_project` 1문장 → 소유 행 CASCADE,
   * 다른 프로젝트의 origin_project_id·copied_from_project_id는 SET NULL.
   */
  async deleteProject(key: string, confirmKey: string, a: Audit): Promise<void> {
    const p = await this.findByKey(key, 'PROJECT');
    if (p.status !== 'ARCHIVED')
      throw new ConflictProblem('E_PROJECT_ACTIVE', API_ERROR_CODES.E_PROJECT_ACTIVE);
    assertConfirmKey(key, confirmKey);
    await this.db.delete(tfProject).where(eq(tfProject.projectId, p.id));
    this.logger.warn(`프로젝트 삭제: ${key} by ${a.actor}`);
  }
}

/** 키 재입력 불일치 → 422(§9.3 "키 불일치 422"). */
export function assertConfirmKey(key: string, confirmKey: string): void {
  if (key !== confirmKey) {
    throw new ValidationProblem([
      {
        code: 'E_CONFIRM_KEY_MISMATCH',
        target: 'field',
        field: 'confirmKey',
        message: API_ERROR_CODES.E_CONFIRM_KEY_MISMATCH,
      },
    ]);
  }
}
