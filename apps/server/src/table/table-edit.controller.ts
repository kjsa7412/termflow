import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  historyRestoreSchema,
  tableCloneSchema,
  tableCreateSchema,
  tableSaveSchema,
  tableStatusSchema,
  tableValidateSchema,
  type TableCloneResponse,
  type TableDetail,
  type TableHistoryDetail,
  type TableHistoryItem,
  type TableSaveResponse,
  type TableStatusResponse,
  type TableValidateResponse,
} from '@termflow/shared';
import type { z } from 'zod';
import { ProjectRole } from '../auth/decorators.js';
import { AuditContext } from '../common/audit/audit-context.js';
import { UnauthorizedProblem } from '../common/problem/problem.exception.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import type { ProjectCtx } from '../common/project-context.js';
import { TableCloneService } from './table-clone.service.js';
import { TableService } from './table.service.js';

const ctxOf = (req: Request): ProjectCtx => req.projectCtx!;

/**
 * 테이블 설계 편집 API(단계 8, 설계서 §9.3·§8, T8.1~T8.6). 권한(§7.3): 조회 = 조회자, 쓰기·검증 = 편집자,
 * FINAL→DRAFT·FINAL 삭제 = 프로젝트 관리자(서비스가 판정), 복제 = 원본 조회자 + 대상 편집자.
 */
@Controller('projects/:projectKey')
export class TableEditController {
  constructor(
    private readonly tables: TableService,
    private readonly cloner: TableCloneService,
    private readonly auditCtx: AuditContext,
  ) {}

  /** POST P/tables/validate — 저장 본문 검증(기록 없음). `tables/:id`보다 먼저 선언(경로 충돌 방지). */
  @Post('tables/validate')
  @HttpCode(200)
  @ProjectRole('EDITOR')
  validate(
    @Req() req: Request,
    @Body(new ZodValidationPipe(tableValidateSchema)) body: z.output<typeof tableValidateSchema>,
  ): Promise<TableValidateResponse> {
    return this.tables.validate(ctxOf(req), body);
  }

  @Post('tables')
  @ProjectRole('EDITOR')
  async create(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(tableCreateSchema)) body: z.output<typeof tableCreateSchema>,
  ): Promise<TableSaveResponse> {
    const ctx = ctxOf(req);
    const r = await this.tables.create(ctx, body, this.auditCtx.current());
    res.setHeader('Location', `/api/v1/projects/${ctx.projectKey}/tables/${r.tableId}`);
    return r;
  }

  @Get('tables/:id')
  @ProjectRole('VIEWER')
  detail(@Req() req: Request, @Param('id', ParseIntPipe) id: number): Promise<TableDetail> {
    return this.tables.detail(ctxOf(req), id);
  }

  @Put('tables/:id')
  @ProjectRole('EDITOR')
  save(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(tableSaveSchema)) body: z.output<typeof tableSaveSchema>,
  ): Promise<TableSaveResponse> {
    return this.tables.save(ctxOf(req), id, body, this.auditCtx.current());
  }

  @Delete('tables/:id')
  @HttpCode(204)
  @ProjectRole('EDITOR')
  async remove(@Req() req: Request, @Param('id', ParseIntPipe) id: number): Promise<void> {
    await this.tables.remove(ctxOf(req), id, this.auditCtx.current());
  }

  @Put('tables/:id/status')
  @ProjectRole('EDITOR')
  status(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(tableStatusSchema)) body: z.output<typeof tableStatusSchema>,
  ): Promise<TableStatusResponse> {
    return this.tables.setStatus(ctxOf(req), id, body, this.auditCtx.current());
  }

  /** 복제: 경로 프로젝트(원본)는 조회자 이상 + 보관 프로젝트에서도 원본 읽기 허용, 대상 권한은 서비스가 판정. */
  @Post('tables/:id/clone')
  @ProjectRole('VIEWER', { readOnly: true })
  clone(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(tableCloneSchema)) body: z.output<typeof tableCloneSchema>,
  ): Promise<TableCloneResponse> {
    const user = req.authUser;
    if (!user) throw new UnauthorizedProblem();
    return this.cloner.clone(ctxOf(req), id, body, user, this.auditCtx.current());
  }

  @Get('tables/:id/history')
  @ProjectRole('VIEWER')
  history(@Req() req: Request, @Param('id', ParseIntPipe) id: number): Promise<TableHistoryItem[]> {
    return this.tables.history(ctxOf(req), id);
  }

  @Get('tables/:id/history/:version')
  @ProjectRole('VIEWER')
  historyVersion(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Param('version', ParseIntPipe) version: number,
  ): Promise<TableHistoryDetail> {
    return this.tables.historyVersion(ctxOf(req), id, version);
  }

  @Post('tables/:id/history/:version/restore')
  @HttpCode(200)
  @ProjectRole('EDITOR')
  restore(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Param('version', ParseIntPipe) version: number,
    @Body(new ZodValidationPipe(historyRestoreSchema)) body: z.output<typeof historyRestoreSchema>,
  ): Promise<TableSaveResponse> {
    return this.tables.restore(ctxOf(req), id, version, body.version, this.auditCtx.current());
  }
}
