import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  API_ERROR_CODES,
  CLONE_WARNING_CODES,
  DIALECT_IDENTIFIER_MAX,
  formatValidationMessage,
  IDENTIFIER_RE,
  MEMBER_ROLE_RANK,
  type ColumnInput,
  type Dialect,
  type MemberRole,
  type ProjectKind,
  type ProjectStatus,
  type RemapWarning,
  type TableCloneResponse,
} from '@termflow/shared';
import type { AuthUser } from '../auth/session-user.js';
import type { Audit } from '../common/audit/audit.js';
import {
  ConflictProblem,
  ForbiddenProblem,
  NotFoundProblem,
  ValidationProblem,
} from '../common/problem/problem.exception.js';
import type { ProjectCtx } from '../common/project-context.js';
import { insertAudited } from '../db/audit.js';
import type { Db } from '../db/client.js';
import { DRIZZLE } from '../db/db.module.js';
import { prjTable } from '../db/schema.js';
import { rowsOf, type ExecQ } from '../project/sql-util.js';
import { planColumnDiff } from './column-diff.js';
import { loadColumns, loadHeader } from './table-detail.loader.js';
import { TableService } from './table.service.js';

const PROJECT_NOT_FOUND = '프로젝트를 찾을 수 없습니다';

/** 복제 이름 규칙(§8.4): `{원본}_COPY`, 중복이면 `_COPY2`, `_COPY3` … 식별자 상한(기본 방언)을 넘으면 원본 쪽을 자른다. */
export function copyName(base: string, taken: ReadonlySet<string>, max: number): string {
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '_COPY' : `_COPY${n}`;
    const name = `${base.slice(0, Math.max(1, max - suffix.length))}${suffix}`;
    if (!taken.has(name)) return name;
  }
}

/**
 * 테이블 복제(단계 8, 설계서 §8.4·§3.5.12·Q10, T8.6).
 *  - 같은 프로젝트: 편집자 이상, 업무구분 기본 = 원본, 이름 `_COPY`(`_COPY2`…), 참조 그대로
 *  - 다른 프로젝트(C7): 원본 조회자 이상(경로 가드) + 대상 편집자 이상, 업무구분 기본 = 원본 `biz_cd`와 같은 코드,
 *    도메인(논리명)·코드구분(`biz_cd`, `code_cls`)·기본컬럼(물리명, 대상 기본 세트 우선) 자연키 재매핑,
 *    못 찾으면 NULL + `remapWarnings`. 물리명·타입은 원본 그대로(대상 표준과 다르면 검증 경고로 드러난다)
 *  - 결과는 새 DRAFT(version 1) + 이력 CLONE(원본 프로젝트·테이블·버전 기록)
 */
@Injectable()
export class TableCloneService {
  private readonly logger = new Logger('TableClone');

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly tables: TableService,
  ) {}

  /** 대상 프로젝트 문맥(가드와 같은 규칙: 비멤버·없는 키·비SA의 템플릿 404, 편집자 미만 403, 템플릿 409, 보관 409). */
  private async target(src: ProjectCtx, key: string | undefined, user: AuthUser): Promise<ProjectCtx> {
    if (key === undefined || key === src.projectKey) {
      if (MEMBER_ROLE_RANK[src.role] < MEMBER_ROLE_RANK.EDITOR) throw new ForbiddenProblem();
      this.tables.assertNotTemplate(src);
      if (src.status === 'ARCHIVED')
        throw new ConflictProblem('E_PROJECT_READONLY', API_ERROR_CODES.E_PROJECT_READONLY);
      return src;
    }
    const [row] = await rowsOf<{
      project_id: number;
      kind: ProjectKind;
      status: ProjectStatus;
      member_role: MemberRole | null;
    }>(
      this.db,
      sql`select p.project_id, p.kind, p.status, m.member_role
            from tf_project p
            left join tf_project_member m on m.project_id = p.project_id and m.user_id = ${user.id}
           where p.project_key = ${key}`,
    );
    if (!row) throw new NotFoundProblem(PROJECT_NOT_FOUND);
    if (row.kind === 'TEMPLATE' && !user.isSysAdmin) throw new NotFoundProblem(PROJECT_NOT_FOUND);
    const role: MemberRole | null = user.isSysAdmin ? 'ADMIN' : row.member_role;
    if (!role) throw new NotFoundProblem(PROJECT_NOT_FOUND);
    if (MEMBER_ROLE_RANK[role] < MEMBER_ROLE_RANK.EDITOR) throw new ForbiddenProblem();
    const ctx: ProjectCtx = {
      projectId: row.project_id,
      projectKey: key,
      kind: row.kind,
      status: row.status,
      role,
      sysAdmin: user.isSysAdmin,
    };
    this.tables.assertNotTemplate(ctx);
    if (ctx.status === 'ARCHIVED')
      throw new ConflictProblem('E_PROJECT_READONLY', API_ERROR_CODES.E_PROJECT_READONLY);
    return ctx;
  }

  private async targetBiz(
    q: ExecQ,
    target: ProjectCtx,
    same: boolean,
    requested: number | undefined,
    source: { bizAreaId: number; bizCd: string },
  ): Promise<number> {
    const rows = await rowsOf<{ biz_area_id: number; biz_cd: string; use_yn: boolean }>(
      q,
      sql`select biz_area_id, biz_cd, use_yn from prj_biz_area where project_id = ${target.projectId}`,
    );
    const bad = (code: 'E_BIZ_AREA_NOT_FOUND' | 'E_BIZ_AREA_INACTIVE' | 'E_BIZ_AREA_REQUIRED', message: string) =>
      new ValidationProblem([{ code, target: 'table', field: 'bizAreaId', message }]);
    let b: (typeof rows)[number] | undefined;
    if (requested !== undefined) {
      b = rows.find((r) => r.biz_area_id === requested);
      if (!b) throw bad('E_BIZ_AREA_NOT_FOUND', API_ERROR_CODES.E_BIZ_AREA_NOT_FOUND);
    } else {
      b = same
        ? rows.find((r) => r.biz_area_id === source.bizAreaId)
        : rows.find((r) => r.biz_cd === source.bizCd);
      if (!b) {
        throw bad(
          'E_BIZ_AREA_REQUIRED',
          `대상 프로젝트에 업무구분 ${source.bizCd}가 없습니다 — 업무구분을 선택하세요`,
        );
      }
    }
    if (!b.use_yn)
      throw bad('E_BIZ_AREA_INACTIVE', `사용 중지된 업무구분(${b.biz_cd})에는 복제할 수 없습니다`);
    return b.biz_area_id;
  }

  /** 다른 프로젝트: 도메인(논리명)·코드구분(biz_cd/code_cls)·기본컬럼(물리명, 기본 세트 우선) 자연키 재매핑. */
  private async remap(
    q: ExecQ,
    targetId: number,
    cols: Awaited<ReturnType<typeof loadColumns>>,
  ): Promise<{ columns: ColumnInput[]; warnings: RemapWarning[] }> {
    const srcDomainIds = [...new Set(cols.map((c) => c.domainId).filter((x): x is number => x !== null))];
    const [srcDomains, tgtCodes, tgtDefaults] = await Promise.all([
      srcDomainIds.length === 0
        ? Promise.resolve([] as { domain_id: number; logical_nm: string }[])
        : rowsOf<{ domain_id: number; logical_nm: string }>(
            q,
            sql`select domain_id, logical_nm from std_domain where domain_id = any(${sql.param(srcDomainIds)}::int[])`,
          ),
      rowsOf<{ code_cls_id: number; key: string }>(
        q,
        sql`select c.code_cls_id, b.biz_cd || '/' || c.code_cls key
              from std_code_cls c join prj_biz_area b on b.biz_area_id = c.biz_area_id
             where c.project_id = ${targetId}`,
      ),
      rowsOf<{ default_col_id: number; physical_nm: string }>(
        q,
        sql`select dc.default_col_id, dc.physical_nm
              from std_default_col dc join tf_project p on p.project_id = dc.project_id
             where dc.project_id = ${targetId}
             order by (dc.set_id is not distinct from p.default_col_set_id) desc, dc.set_id, dc.col_seq`,
      ),
    ]);
    const domainNm = new Map(srcDomains.map((d) => [d.domain_id, d.logical_nm]));
    const names = [...new Set(srcDomains.map((d) => d.logical_nm))];
    const tgtDomains =
      names.length === 0
        ? []
        : await rowsOf<{ domain_id: number; logical_nm: string }>(
            q,
            sql`select domain_id, logical_nm from std_domain
                 where project_id = ${targetId} and logical_nm = any(${sql.param(names)}::text[])`,
          );
    const domainBy = new Map(tgtDomains.map((d) => [d.logical_nm, d.domain_id]));
    const codeBy = new Map(tgtCodes.map((c) => [c.key, c.code_cls_id]));
    const defaultBy = new Map<string, number>();
    for (const d of tgtDefaults) if (!defaultBy.has(d.physical_nm)) defaultBy.set(d.physical_nm, d.default_col_id);

    const warnings: RemapWarning[] = [];
    const warn = (
      code: RemapWarning['code'],
      i: number,
      columnNm: string,
      field: RemapWarning['field'],
      sourceKey: string,
    ) =>
      warnings.push({
        code,
        rowIndex: i,
        columnNm,
        field,
        sourceKey,
        message: `${columnNm}: ${CLONE_WARNING_CODES[code]}(${sourceKey})`,
      });
    const columns = cols.map((c, i): ColumnInput => {
      let domainId: number | null = null;
      if (c.domainId !== null) {
        const nm = domainNm.get(c.domainId) ?? c.domainNm ?? `#${c.domainId}`;
        domainId = domainBy.get(nm) ?? null;
        if (domainId === null) warn('W_REMAP_DOMAIN', i, c.physicalNm, 'domainId', nm);
      }
      let codeClsId: number | null = null;
      if (c.codeClsId !== null) {
        const key = c.codeCls ? `${c.codeCls.bizCd}/${c.codeCls.codeCls}` : `#${c.codeClsId}`;
        codeClsId = codeBy.get(key) ?? null;
        if (codeClsId === null) warn('W_REMAP_CODE_CLS', i, c.physicalNm, 'codeClsId', key);
      }
      let defaultColId: number | null = null;
      if (c.defaultColId !== null) {
        defaultColId = defaultBy.get(c.physicalNm) ?? null;
        if (defaultColId === null)
          warn('W_REMAP_DEFAULT_COL', i, c.physicalNm, 'defaultColId', c.physicalNm);
      }
      return {
        columnId: null,
        logicalNm: c.logicalNm,
        physicalNm: c.physicalNm,
        isPk: c.isPk,
        dataType: c.dataType,
        dataLength: c.dataLength,
        dataScale: c.dataScale,
        isNullable: c.isNullable,
        defaultVal: c.defaultVal,
        colComment: c.colComment,
        domainId,
        codeClsId,
        defaultColId,
        matchType: c.matchType,
      };
    });
    return { columns, warnings };
  }

  async clone(
    src: ProjectCtx,
    tableId: number,
    input: { targetProjectKey?: string | undefined; targetBizAreaId?: number | undefined; tableNm?: string | undefined },
    user: AuthUser,
    a: Audit,
  ): Promise<TableCloneResponse> {
    const header = await loadHeader(this.db, src.projectId, src.projectKey, tableId);
    if (!header) throw new NotFoundProblem('테이블을 찾을 수 없습니다');
    const tgt = await this.target(src, input.targetProjectKey, user);
    const same = tgt.projectId === src.projectId;
    const srcCols = await loadColumns(this.db, src.projectId, tableId);

    const r = await this.db.transaction(async (tx) => {
      const bizAreaId = await this.targetBiz(tx, tgt, same, input.targetBizAreaId, header);
      const [names, [proj]] = await Promise.all([
        rowsOf<{ table_nm: string }>(
          tx,
          sql`select table_nm from prj_table where project_id = ${tgt.projectId}`,
        ),
        rowsOf<{ default_dialect: Dialect }>(
          tx,
          sql`select default_dialect from tf_project where project_id = ${tgt.projectId}`,
        ),
      ]);
      const taken = new Set(names.map((n) => n.table_nm));
      const max = DIALECT_IDENTIFIER_MAX[proj?.default_dialect ?? 'POSTGRESQL'];
      let tableNm: string;
      if (input.tableNm !== undefined && input.tableNm.trim() !== '') {
        tableNm = input.tableNm.trim().toUpperCase();
        const issue = (code: 'E_PHYS_FORMAT' | 'E_PHYS_LEN' | 'E_TABLE_NM_DUP') => ({
          code,
          target: 'table' as const,
          field: 'tableNm',
          tableNm,
          message: formatValidationMessage(code, { max, dialect: proj?.default_dialect ?? '' }),
        });
        if (!IDENTIFIER_RE.test(tableNm)) throw new ValidationProblem([issue('E_PHYS_FORMAT')]);
        if (tableNm.length > max) throw new ValidationProblem([issue('E_PHYS_LEN')]);
        if (taken.has(tableNm)) throw new ValidationProblem([issue('E_TABLE_NM_DUP')]);
      } else {
        tableNm = !same && !taken.has(header.tableNm) ? header.tableNm : copyName(header.tableNm, taken, max);
      }
      const { columns, warnings } = same
        ? {
            columns: srcCols.map(
              (c): ColumnInput => ({
                columnId: null,
                logicalNm: c.logicalNm,
                physicalNm: c.physicalNm,
                isPk: c.isPk,
                dataType: c.dataType,
                dataLength: c.dataLength,
                dataScale: c.dataScale,
                isNullable: c.isNullable,
                defaultVal: c.defaultVal,
                colComment: c.colComment,
                domainId: c.domainId,
                codeClsId: c.codeClsId,
                defaultColId: c.defaultColId,
                matchType: c.matchType,
              }),
            ),
            warnings: [] as RemapWarning[],
          }
        : await this.remap(tx, tgt.projectId, srcCols);

      const [t] = await insertAudited(
        tx,
        prjTable,
        {
          projectId: tgt.projectId,
          bizAreaId,
          tableNm,
          tableLogicalNm: header.tableLogicalNm,
          description: header.description,
          status: 'DRAFT',
          version: 1,
        },
        a,
      ).returning({ tableId: prjTable.tableId });
      const newId = t!.tableId;
      await this.tables.applyColumns(tx, tgt.projectId, newId, planColumnDiff([], columns), a);
      const summary = `복제: ${src.projectKey}/${header.tableNm} v${header.version}${
        warnings.length > 0 ? ` · 재매핑 실패 ${warnings.length}` : ''
      }`;
      await this.tables.writeHistory(
        tx,
        tgt,
        newId,
        {
          action: 'CLONE',
          changeSummary: summary,
          extra: {
            clonedFrom: {
              projectKey: src.projectKey,
              tableId,
              tableNm: header.tableNm,
              version: header.version,
            },
          },
        },
        a,
      );
      return { newId, bizAreaId, tableNm, warnings };
    });
    this.logger.log(
      `테이블 복제: ${src.projectKey}/${header.tableNm} → ${tgt.projectKey}/${r.tableNm} by ${a.actor}` +
        (r.warnings.length > 0 ? ` (재매핑 실패 ${r.warnings.length})` : ''),
    );
    return {
      tableId: r.newId,
      projectKey: tgt.projectKey,
      bizAreaId: r.bizAreaId,
      tableNm: r.tableNm,
      version: 1,
      remapWarnings: r.warnings,
    };
  }
}
