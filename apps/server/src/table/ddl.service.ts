import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  API_ERROR_CODES,
  DDL_EXPORT_TABLES_MAX,
  type DdlExtractRequest,
  type DdlExtractResponse,
  type DdlOptions,
  type DdlOutputKind,
  type DdlRequest,
  type DdlResponse,
  type Dialect,
  type ExportLogInput,
  type ExportLogItem,
  type Page,
  type PageQuery,
  type TableCreateInput,
} from '@termflow/shared';
import type { Audit } from '../common/audit/audit.js';
import { toPage } from '../common/pagination.js';
import { NotFoundProblem, ValidationProblem } from '../common/problem/problem.exception.js';
import type { ProjectCtx } from '../common/project-context.js';
import type { Db } from '../db/client.js';
import { DRIZZLE } from '../db/db.module.js';
import type { DdlDialect } from '../ddl/dialect.js';
import { dialectFor, UnsupportedDialectError } from '../ddl/dialects.js';
import { extractTables } from '../ddl/extractor.js';
import { fileStamp, generateBundle, type Bundle } from '../ddl/generator.js';
import type { DdlMeta, TableModel } from '../ddl/model.js';
import { validateTable, type ValidationResult } from '../ddl/validator.js';
import { zipFiles } from '../ddl/zip.js';
import { isoTs, rowsOf } from '../project/sql-util.js';
import { draftModel, loadBizAreas, loadSuffixes, loadTableModels } from './table-model.loader.js';

/**
 * DDL 생성·내보내기 서비스(설계서 §6.1·§6.10·§6.11·§9.3, T7.8). 서버측 생성이 진실(P4) — 화면은 결과를 표시만 한다.
 *  - 선택: tableIds(사용자 순서) → bizAreaIds(업무구분 sort_no → 물리명), 합쳐서 200 상한, 모두 이 프로젝트 소속(아니면 404)
 *  - 재검증(§5.7): 기본 방언 기준. E가 하나라도 있으면 422(errors·warnings), W는 응답·파일 상단 요약에 동봉
 *  - 기록(`ddl_export_log`): SQL 다운로드 DOWNLOAD · ZIP · 정보 추출 TSV EXTRACT · 화면 복사 COPY(POST export-logs). 미리보기(JSON) 미기록
 */
export interface Selection {
  tableIds?: number[] | undefined;
  bizAreaIds?: number[] | undefined;
}

interface Built {
  dialect: DdlDialect;
  models: TableModel[];
  bundle: Bundle;
  meta: DdlMeta;
  opts: DdlOptions;
}

/** 서버 로컬 시각 `yyyy-MM-dd HH:mm`(헤더·파일명, §6.10). */
export function localMinute(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

@Injectable()
export class DdlService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async project(ctx: ProjectCtx): Promise<{ projectNm: string; defaultDialect: Dialect }> {
    const [p] = await rowsOf<{ project_nm: string; default_dialect: Dialect }>(
      this.db,
      sql`select project_nm, default_dialect from tf_project where project_id = ${ctx.projectId}`,
    );
    if (!p) throw new NotFoundProblem();
    return { projectNm: p.project_nm, defaultDialect: p.default_dialect };
  }

  private dialect(d: Dialect): DdlDialect {
    try {
      return dialectFor(d);
    } catch (e) {
      if (e instanceof UnsupportedDialectError) {
        throw new ValidationProblem(
          [
            {
              code: 'E_DIALECT_UNSUPPORTED',
              target: 'field',
              field: 'dialect',
              message: `${d}: ${API_ERROR_CODES.E_DIALECT_UNSUPPORTED}`,
            },
          ],
          [],
          API_ERROR_CODES.E_DIALECT_UNSUPPORTED,
        );
      }
      throw e;
    }
  }

  /** 선택 → 순서 있는 테이블 ID(§6.10). 다른 프로젝트·없는 ID는 404(존재 노출 방지), 0건·200 초과는 422. */
  async resolveSelection(ctx: ProjectCtx, s: Selection): Promise<number[]> {
    const ids: number[] = [];
    const seen = new Set<number>();
    const add = (id: number) => {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    };
    if (s.tableIds && s.tableIds.length > 0) {
      const found = await rowsOf<{ table_id: number }>(
        this.db,
        sql`select table_id from prj_table where project_id = ${ctx.projectId}
             and table_id = any(${sql.param([...s.tableIds])}::int[])`,
      );
      const ok = new Set(found.map((r) => r.table_id));
      const missing = s.tableIds.filter((id) => !ok.has(id));
      if (missing.length > 0)
        throw new NotFoundProblem(`테이블을 찾을 수 없습니다: ${missing.join(', ')}`);
      s.tableIds.forEach(add);
    }
    if (s.bizAreaIds && s.bizAreaIds.length > 0) {
      const biz = await rowsOf<{ biz_area_id: number }>(
        this.db,
        sql`select biz_area_id from prj_biz_area where project_id = ${ctx.projectId}
             and biz_area_id = any(${sql.param([...s.bizAreaIds])}::int[])`,
      );
      const ok = new Set(biz.map((r) => r.biz_area_id));
      const missing = s.bizAreaIds.filter((id) => !ok.has(id));
      if (missing.length > 0)
        throw new NotFoundProblem(`업무구분을 찾을 수 없습니다: ${missing.join(', ')}`);
      const rows = await rowsOf<{ table_id: number }>(
        this.db,
        sql`select t.table_id from prj_table t join prj_biz_area b on b.biz_area_id = t.biz_area_id
             where t.project_id = ${ctx.projectId} and t.biz_area_id = any(${sql.param([...s.bizAreaIds])}::int[])
             order by b.sort_no, b.biz_cd collate "C", t.table_nm collate "C"`,
      );
      rows.forEach((r) => add(r.table_id));
    }
    if (ids.length === 0) {
      throw new ValidationProblem(
        [
          {
            code: 'E_DDL_NO_TABLES',
            target: 'field',
            field: 'tableIds',
            message: API_ERROR_CODES.E_DDL_NO_TABLES,
          },
        ],
        [],
        API_ERROR_CODES.E_DDL_NO_TABLES,
      );
    }
    if (ids.length > DDL_EXPORT_TABLES_MAX) {
      throw new ValidationProblem(
        [
          {
            code: 'E_DDL_TABLES_MAX',
            target: 'field',
            field: 'tableIds',
            message: `${API_ERROR_CODES.E_DDL_TABLES_MAX} — 선택 ${ids.length}개`,
          },
        ],
        [],
        API_ERROR_CODES.E_DDL_TABLES_MAX,
      );
    }
    return ids;
  }

  /** 재검증(기본 방언 기준, §5.7). */
  async validateModels(
    ctx: ProjectCtx,
    models: readonly TableModel[],
    defaultDialect: Dialect,
    opts: Pick<DdlOptions, 'quoteIdentifiers'>,
  ): Promise<ValidationResult[]> {
    const suffixes = await loadSuffixes(this.db, ctx.projectId);
    return models.map((m) =>
      validateTable(m, {
        dialect: defaultDialect,
        quoteIdentifiers: opts.quoteIdentifiers,
        suffixes,
      }),
    );
  }

  private async build(
    ctx: ProjectCtx,
    req: Selection & {
      dialect?: Dialect | undefined;
      options: DdlOptions;
      draft?: TableCreateInput | undefined;
    },
    who: Audit,
  ): Promise<Built> {
    const p = await this.project(ctx);
    const dialect = this.dialect(req.dialect ?? p.defaultDialect);
    let models: TableModel[];
    if (req.draft) {
      const bizAreas = await loadBizAreas(this.db, ctx.projectId);
      if (!bizAreas.some((b) => b.biz_area_id === req.draft!.table.bizAreaId)) {
        throw new ValidationProblem([
          {
            code: 'E_BIZ_AREA_NOT_FOUND',
            target: 'table',
            field: 'bizAreaId',
            message: API_ERROR_CODES.E_BIZ_AREA_NOT_FOUND,
          },
        ]);
      }
      models = [await draftModel(this.db, ctx.projectId, req.draft, bizAreas)];
    } else {
      const ids = await this.resolveSelection(ctx, req);
      models = await loadTableModels(this.db, ctx.projectId, ids);
    }
    const results = await this.validateModels(ctx, models, p.defaultDialect, req.options);
    const errors = results.flatMap((r) => r.errors);
    if (errors.length > 0) {
      const bad = results.filter((r) => r.errors.length > 0).length;
      throw new ValidationProblem(
        errors,
        results.flatMap((r) => r.warnings),
        `오류 ${errors.length}건(테이블 ${bad}개) — 오류가 있는 테이블은 DDL을 만들 수 없습니다`,
      );
    }
    const meta: DdlMeta = {
      projectKey: ctx.projectKey,
      projectNm: p.projectNm,
      generatedAt: localMinute(new Date()),
      generatedBy: who.actor,
    };
    const bundle = generateBundle(
      dialect,
      models.map((model, i) => ({ model, warnings: results[i]!.warnings })),
      req.options,
      meta,
    );
    return { dialect, models, bundle, meta, opts: req.options };
  }

  private response(b: Built): DdlResponse {
    const size = (s: string) => Buffer.byteLength(s, 'utf8');
    const files =
      b.opts.fileSplit === 'PER_TABLE'
        ? b.bundle.perTableFiles.map((f) => ({ name: f.name, size: size(f.content) }))
        : [{ name: b.bundle.singleFileName, size: size(b.bundle.sql) }];
    return {
      dialect: b.dialect.id(),
      tableCnt: b.models.length,
      sql: b.bundle.sql,
      files,
      tables: b.bundle.tables.map((t) => ({
        tableId: t.model.tableId,
        tableNm: t.model.tableNm,
        logicalNm: t.model.logicalNm,
        bizCd: t.model.bizCd,
        status: t.model.status,
        version: t.model.version,
        colCnt: t.model.columns.length,
        sql: t.sql,
        warningCnt: t.warnings.length,
      })),
      warnings: b.bundle.warnings,
    };
  }

  /** POST P/ddl output=JSON(미리보기, 기록 없음). */
  async preview(ctx: ProjectCtx, req: DdlRequest, who: Audit): Promise<DdlResponse> {
    return this.response(await this.build(ctx, req, who));
  }

  /** POST P/ddl output=SQL → 단일 .sql(DOWNLOAD 기록). */
  async downloadSql(
    ctx: ProjectCtx,
    req: DdlRequest,
    who: Audit,
  ): Promise<{ fileName: string; body: string; warningCnt: number }> {
    const b = await this.build(ctx, req, who);
    await this.log(
      ctx,
      'DOWNLOAD',
      b.dialect.id(),
      b.models,
      b.opts,
      b.bundle.warnings.length,
      who,
    );
    return {
      fileName: b.bundle.singleFileName,
      body: b.bundle.sql,
      warningCnt: b.bundle.warnings.length,
    };
  }

  /** POST P/ddl output=ZIP → `{BIZ_CD}/{NN}_{TABLE}.sql` + `_warnings.txt`(ZIP 기록). */
  async downloadZip(
    ctx: ProjectCtx,
    req: DdlRequest,
    who: Audit,
  ): Promise<{ fileName: string; body: Buffer; warningCnt: number }> {
    const b = await this.build(
      ctx,
      { ...req, options: { ...req.options, fileSplit: 'PER_TABLE' } },
      who,
    );
    const body = await zipFiles(b.bundle.perTableFiles, new Date());
    await this.log(ctx, 'ZIP', b.dialect.id(), b.models, b.opts, b.bundle.warnings.length, who);
    return { fileName: b.bundle.zipFileName, body, warningCnt: b.bundle.warnings.length };
  }

  /** GET P/tables/{id}/ddl — 테이블 1개(text/plain 또는 JSON). 기록 없음(미리보기와 같음). */
  async tableDdl(
    ctx: ProjectCtx,
    tableId: number,
    dialect: Dialect | undefined,
    options: DdlOptions,
    who: Audit,
  ): Promise<DdlResponse> {
    return this.preview(
      ctx,
      { tableIds: [tableId], dialect, options, output: 'JSON' } as DdlRequest,
      who,
    );
  }

  /** POST P/ddl/extract(§6.11): JSON 미리보기(기록 없음) / TSV 다운로드(EXTRACT 기록, 엑셀용 BOM). */
  async extract(ctx: ProjectCtx, req: DdlExtractRequest, who: Audit): Promise<DdlExtractResponse> {
    const p = await this.project(ctx);
    const dialect = this.dialect(req.dialect ?? p.defaultDialect);
    const ids = await this.resolveSelection(ctx, req);
    const models = await loadTableModels(this.db, ctx.projectId, ids);
    const r = extractTables(dialect, models, req.options);
    const fileName = `${ctx.projectKey}_tables_${fileStamp(localMinute(new Date()))}.tsv`;
    if (req.output === 'TSV') {
      const warnings = (
        await this.validateModels(ctx, models, p.defaultDialect, req.options)
      ).reduce((n, v) => n + v.warnings.length, 0);
      await this.log(ctx, 'EXTRACT', dialect.id(), models, req.options, warnings, who);
    }
    return {
      dialect: dialect.id(),
      tableCnt: models.length,
      rowCnt: r.rowCnt,
      text: r.text,
      fileName,
    };
  }

  /** POST P/export-logs — 화면 복사(COPY: DDL, EXTRACT: 탭 구분 텍스트). 테이블은 이 프로젝트 소속만(404). */
  async recordCopy(
    ctx: ProjectCtx,
    input: ExportLogInput,
    who: Audit,
  ): Promise<{ exportId: number }> {
    const p = await this.project(ctx);
    const ids = await this.resolveSelection(ctx, { tableIds: input.tableIds });
    const id = await this.log(
      ctx,
      input.kind,
      input.dialect ?? p.defaultDialect,
      ids.map((tableId) => ({ tableId })),
      input.options,
      input.warningCnt,
      who,
    );
    return { exportId: id };
  }

  private async log(
    ctx: ProjectCtx,
    kind: DdlOutputKind,
    dialect: Dialect,
    models: readonly { tableId: number | null }[],
    options: DdlOptions,
    warningCnt: number,
    who: Audit,
  ): Promise<number> {
    const ids = models.map((m) => m.tableId).filter((x): x is number => x !== null);
    const [r] = await rowsOf<{ export_id: number }>(
      this.db,
      sql`insert into ddl_export_log (project_id, dialect, output_kind, table_ids, options, table_cnt, warning_cnt, exported_by, exported_ip)
          values (${ctx.projectId}, ${dialect}, ${kind}, ${JSON.stringify(ids)}::jsonb, ${JSON.stringify(options)}::jsonb,
                  ${ids.length}, ${Math.min(warningCnt, 32_767)}, ${who.actor}, ${who.ip})
          returning export_id`,
    );
    return Number(r!.export_id);
  }

  /** GET P/export-logs — 최근순. */
  async listLogs(ctx: ProjectCtx, q: PageQuery): Promise<Page<ExportLogItem>> {
    const [total] = await rowsOf<{ n: number }>(
      this.db,
      sql`select count(*)::int n from ddl_export_log where project_id = ${ctx.projectId}`,
    );
    const rows = await rowsOf<{
      export_id: string | number;
      dialect: Dialect;
      output_kind: DdlOutputKind;
      table_ids: number[];
      table_cnt: number;
      warning_cnt: number;
      first_table_nm: string | null;
      exported_by: string;
      exported_by_nm: string | null;
      exported_at: string;
    }>(
      this.db,
      sql`select l.export_id, l.dialect, l.output_kind, l.table_ids, l.table_cnt, l.warning_cnt,
                 (select t.table_nm from prj_table t where t.project_id = l.project_id
                   and t.table_id = (l.table_ids->>0)::int) first_table_nm,
                 l.exported_by, u.user_nm exported_by_nm, ${isoTs(sql`l.exported_at`)} exported_at
            from ddl_export_log l left join tf_user u on u.login_id = l.exported_by
           where l.project_id = ${ctx.projectId}
           order by l.exported_at desc, l.export_id desc
           limit ${q.size} offset ${(q.page - 1) * q.size}`,
    );
    return toPage(
      rows.map((r) => ({
        exportId: Number(r.export_id),
        dialect: r.dialect,
        outputKind: r.output_kind,
        tableIds: r.table_ids,
        tableCnt: r.table_cnt,
        warningCnt: r.warning_cnt,
        firstTableNm: r.first_table_nm,
        exportedBy: r.exported_by,
        exportedByNm: r.exported_by_nm,
        exportedAt: r.exported_at,
      })),
      total?.n ?? 0,
      q,
    );
  }
}
