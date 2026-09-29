import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ddlExtractRequestSchema,
  ddlOptionsSchema,
  ddlRequestSchema,
  exportLogQuerySchema,
  exportLogSchema,
  tableDdlQuerySchema,
  tableListQuerySchema,
  type DdlExtractResponse,
  type DdlResponse,
  type ExportLogItem,
  type Page,
  type TablePage,
} from '@termflow/shared';
import type { z } from 'zod';
import { ProjectRole } from '../auth/decorators.js';
import { AuditContext } from '../common/audit/audit-context.js';
import { BadRequestProblem } from '../common/problem/problem.exception.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import type { ProjectCtx } from '../common/project-context.js';
import { DdlService } from './ddl.service.js';
import { TableListService } from './table-list.service.js';

const ctxOf = (req: Request): ProjectCtx => req.projectCtx!;
const P = 'projects/:projectKey';

/** RFC 6266: ASCII 파일명 + filename*(UTF-8). 파일명은 프로젝트 키·방언·시각뿐이라 ASCII지만 방어적으로 둘 다. */
function disposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * 테이블 목록·단일 DDL(단계 7, 설계서 §9.3). 쓰기 API(POST/PUT/DELETE P/tables…)는 단계 8(T8.1~T8.6).
 */
@Controller(P)
export class TablesController {
  constructor(
    private readonly list: TableListService,
    private readonly ddl: DdlService,
    private readonly auditCtx: AuditContext,
  ) {}

  @Get('tables')
  @ProjectRole('VIEWER')
  tables(
    @Req() req: Request,
    @Query(new ZodValidationPipe(tableListQuerySchema)) q: z.output<typeof tableListQuerySchema>,
  ): Promise<TablePage> {
    return this.list.list(ctxOf(req), q);
  }

  /** GET P/tables/{id}/ddl?dialect&…옵션 — 기본 text/plain, `format=json`이면 DdlResponse. 기록 없음. */
  @Get('tables/:id/ddl')
  @ProjectRole('VIEWER')
  async tableDdl(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('id', ParseIntPipe) id: number,
    @Query(new ZodValidationPipe(tableDdlQuerySchema)) q: z.output<typeof tableDdlQuerySchema>,
  ): Promise<DdlResponse | string> {
    const { dialect, format, ...rest } = q;
    const parsed = ddlOptionsSchema.safeParse(
      Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
    );
    if (!parsed.success) {
      throw new BadRequestProblem(
        parsed.error.issues.map((i) => ({
          code: 'E_BAD_REQUEST',
          target: 'field' as const,
          field: i.path.join('.'),
          message: i.message,
        })),
      );
    }
    const r = await this.ddl.tableDdl(
      ctxOf(req),
      id,
      dialect,
      parsed.data,
      this.auditCtx.current(),
    );
    if (format === 'json') return r;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-TermFlow-Warnings', String(r.warnings.length));
    return r.sql;
  }
}

/**
 * DDL 생성·정보 추출·내보내기 기록(단계 7, 설계서 §6.10·§6.11·§9.3). 전부 조회자 이상이고 조회성 POST라
 * 보관 프로젝트에서도 허용한다(`readOnly`). 생성 결과는 서버가 만든 문자열 그대로(P4).
 */
@Controller(P)
export class DdlController {
  constructor(
    private readonly ddl: DdlService,
    private readonly auditCtx: AuditContext,
  ) {}

  /** POST P/ddl — output JSON(미리보기) / SQL(.sql 첨부, DOWNLOAD 기록) / ZIP(테이블별, ZIP 기록). E 있으면 422. */
  @Post('ddl')
  @ProjectRole('VIEWER', { readOnly: true })
  async generate(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(ddlRequestSchema)) body: z.output<typeof ddlRequestSchema>,
  ): Promise<DdlResponse | string | StreamableFile> {
    const ctx = ctxOf(req);
    const who = this.auditCtx.current();
    res.status(200);
    if (body.output === 'SQL') {
      const f = await this.ddl.downloadSql(ctx, body, who);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', disposition(f.fileName));
      res.setHeader('X-TermFlow-Warnings', String(f.warningCnt));
      return f.body;
    }
    if (body.output === 'ZIP') {
      const f = await this.ddl.downloadZip(ctx, body, who);
      res.setHeader('X-TermFlow-Warnings', String(f.warningCnt));
      return new StreamableFile(f.body, {
        type: 'application/zip',
        disposition: disposition(f.fileName),
        length: f.body.length,
      });
    }
    return this.ddl.preview(ctx, body, who);
  }

  /** POST P/ddl/extract — output JSON(미리보기 텍스트) / TSV(.tsv 첨부 + BOM, EXTRACT 기록). */
  @Post('ddl/extract')
  @ProjectRole('VIEWER', { readOnly: true })
  async extract(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(ddlExtractRequestSchema))
    body: z.output<typeof ddlExtractRequestSchema>,
  ): Promise<DdlExtractResponse | string> {
    const r = await this.ddl.extract(ctxOf(req), body, this.auditCtx.current());
    res.status(200);
    if (body.output === 'TSV') {
      res.setHeader('Content-Type', 'text/tab-separated-values; charset=utf-8');
      res.setHeader('Content-Disposition', disposition(r.fileName));
      return `\ufeff${r.text}`;
    }
    return r;
  }

  /** POST P/export-logs — 화면 복사 기록(COPY·EXTRACT). 201. */
  @Post('export-logs')
  @ProjectRole('VIEWER', { readOnly: true })
  record(
    @Req() req: Request,
    @Body(new ZodValidationPipe(exportLogSchema)) body: z.output<typeof exportLogSchema>,
  ): Promise<{ exportId: number }> {
    return this.ddl.recordCopy(ctxOf(req), body, this.auditCtx.current());
  }

  @Get('export-logs')
  @ProjectRole('VIEWER')
  logs(
    @Req() req: Request,
    @Query(new ZodValidationPipe(exportLogQuerySchema)) q: z.output<typeof exportLogQuerySchema>,
  ): Promise<Page<ExportLogItem>> {
    return this.ddl.listLogs(ctxOf(req), q);
  }
}
