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
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  API_PREFIX,
  approvalListQuerySchema,
  auditLogQuerySchema,
  codeClsInputSchema,
  codeClsListQuerySchema,
  codeInputSchema,
  codeListQuerySchema,
  defaultColSetInputSchema,
  defaultColsPutSchema,
  domainCalculateSchema,
  domainClsInputSchema,
  domainClsListQuerySchema,
  domainInputSchema,
  domainListQuerySchema,
  domainRecalculateSchema,
  forceQuerySchema,
  searchQuerySchema,
  termApproveBatchSchema,
  termApproveSchema,
  termCheckQuerySchema,
  termInputSchema,
  termListQuerySchema,
  termRejectSchema,
  type ApprovalBatchResponse,
  type ApprovalPage,
  type AuditLogItem,
  type CodeClsDeleteResponse,
  type CodeClsDetail,
  type CodeClsItem,
  type CodeItem,
  type DefaultColSetItem,
  type DomainCalcResult,
  type DomainClsDeleteResponse,
  type DomainClsItem,
  type DomainClsPage,
  type DomainClsSaveResponse,
  type DomainDetail,
  type DomainPage,
  type DomainRecalcResponse,
  type DomainSaveResponse,
  type Page,
  type SearchResponse,
  type TermCheckResponse,
  type TermDetail,
  type TermPage,
  type TermSaveResponse,
} from '@termflow/shared';
import type { z } from 'zod';
import { ProjectRole } from '../auth/decorators.js';
import { AuditContext } from '../common/audit/audit-context.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import type { ProjectCtx } from '../common/project-context.js';
import { ApprovalService } from './approval.service.js';
import { AuditLogService } from './audit-log.service.js';
import { CodeService } from './code.service.js';
import { DefaultColService } from './default-col.service.js';
import { DomainClsService } from './domain-cls.service.js';
import { DomainService } from './domain.service.js';
import { SearchService } from './search.service.js';
import { TermService } from './term.service.js';

const ctxOf = (req: Request): ProjectCtx => req.projectCtx!;
const S = 'projects/:projectKey/standards';

function created(res: Response, req: Request, path: string): void {
  res.status(201).location(`${API_PREFIX}/projects/${ctxOf(req).projectKey}/standards/${path}`);
}

/**
 * 표준 사전 API(단계 6, 설계서 §9.3·§7.3). 조회 = 조회자 이상, 쓰기 = 프로젝트 관리자(시스템 관리자는 템플릿 포함, §4.6).
 * 컨트롤러 → 서비스(검증·트랜잭션·감사·캐시 무효화) 패턴은 `standard/README.md`.
 */
@Controller(`${S}/terms`)
export class TermsController {
  constructor(
    private readonly terms: TermService,
    private readonly auditCtx: AuditContext,
  ) {}

  @Get()
  @ProjectRole('VIEWER')
  list(
    @Req() req: Request,
    @Query(new ZodValidationPipe(termListQuerySchema)) q: z.output<typeof termListQuerySchema>,
  ): Promise<TermPage> {
    return this.terms.list(ctxOf(req), q);
  }

  @Get('check')
  @ProjectRole('VIEWER')
  check(
    @Req() req: Request,
    @Query(new ZodValidationPipe(termCheckQuerySchema)) q: z.output<typeof termCheckQuerySchema>,
  ): Promise<TermCheckResponse> {
    return this.terms.check(ctxOf(req), q.termKor, q.termPhysical, q.exceptId);
  }

  @Get(':id')
  @ProjectRole('VIEWER')
  detail(@Req() req: Request, @Param('id', ParseIntPipe) id: number): Promise<TermDetail> {
    return this.terms.detail(ctxOf(req), id);
  }

  @Post()
  @ProjectRole('ADMIN')
  async create(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(termInputSchema)) body: z.output<typeof termInputSchema>,
  ): Promise<TermSaveResponse> {
    const r = await this.terms.create(ctxOf(req), body, this.auditCtx.current());
    created(res, req, `terms/${r.term.termId}`);
    return r;
  }

  @Put(':id')
  @ProjectRole('ADMIN')
  update(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(termInputSchema)) body: z.output<typeof termInputSchema>,
  ): Promise<TermSaveResponse> {
    return this.terms.update(ctxOf(req), id, body, this.auditCtx.current());
  }

  @Delete(':id')
  @ProjectRole('ADMIN')
  @HttpCode(204)
  async remove(@Req() req: Request, @Param('id', ParseIntPipe) id: number): Promise<void> {
    await this.terms.remove(ctxOf(req), id, this.auditCtx.current());
  }
}

/** 승인 큐(T6.7, §4.5) — 프로젝트 관리자. */
@Controller(`${S}/approvals`)
export class ApprovalsController {
  constructor(
    private readonly approvals: ApprovalService,
    private readonly auditCtx: AuditContext,
  ) {}

  /** 조회는 §7.3 `P/standards/**` GET(조회자 이상) — 화면(목업 11)은 프로젝트 관리자에게만 노출(CR-05 C3). */
  @Get()
  @ProjectRole('VIEWER')
  list(
    @Req() req: Request,
    @Query(new ZodValidationPipe(approvalListQuerySchema))
    q: z.output<typeof approvalListQuerySchema>,
  ): Promise<ApprovalPage> {
    return this.approvals.list(ctxOf(req), q);
  }

  /** 사이드바 PENDING 배지(30초 폴링, §4.5). */
  @Get('count')
  @ProjectRole('VIEWER')
  count(@Req() req: Request): Promise<{ pending: number }> {
    return this.approvals.count(ctxOf(req));
  }

  @Post('approve-batch')
  @ProjectRole('ADMIN')
  @HttpCode(200)
  batch(
    @Req() req: Request,
    @Body(new ZodValidationPipe(termApproveBatchSchema))
    body: z.output<typeof termApproveBatchSchema>,
  ): Promise<ApprovalBatchResponse> {
    return this.approvals.approveBatch(ctxOf(req), body.termIds, this.auditCtx.current());
  }

  @Post(':termId/approve')
  @ProjectRole('ADMIN')
  @HttpCode(200)
  approve(
    @Req() req: Request,
    @Param('termId', ParseIntPipe) termId: number,
    @Body(new ZodValidationPipe(termApproveSchema)) body: z.output<typeof termApproveSchema>,
  ): Promise<TermSaveResponse> {
    return this.approvals.approve(ctxOf(req), termId, body, this.auditCtx.current());
  }

  @Post(':termId/reject')
  @ProjectRole('ADMIN')
  @HttpCode(200)
  reject(
    @Req() req: Request,
    @Param('termId', ParseIntPipe) termId: number,
    @Body(new ZodValidationPipe(termRejectSchema)) body: z.output<typeof termRejectSchema>,
  ): Promise<TermSaveResponse> {
    return this.approvals.reject(ctxOf(req), termId, body.note, this.auditCtx.current());
  }
}

/** 도메인분류(T6.3). */
@Controller(`${S}/domain-classes`)
export class DomainClassesController {
  constructor(
    private readonly cls: DomainClsService,
    private readonly auditCtx: AuditContext,
  ) {}

  @Get()
  @ProjectRole('VIEWER')
  list(
    @Req() req: Request,
    @Query(new ZodValidationPipe(domainClsListQuerySchema))
    q: z.output<typeof domainClsListQuerySchema>,
  ): Promise<DomainClsPage> {
    return this.cls.list(ctxOf(req), q);
  }

  @Get(':id')
  @ProjectRole('VIEWER')
  detail(@Req() req: Request, @Param('id', ParseIntPipe) id: number): Promise<DomainClsItem> {
    return this.cls.item(ctxOf(req), id);
  }

  @Post()
  @ProjectRole('ADMIN')
  async create(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(domainClsInputSchema)) body: z.output<typeof domainClsInputSchema>,
  ): Promise<DomainClsSaveResponse> {
    const r = await this.cls.create(ctxOf(req), body, this.auditCtx.current());
    created(res, req, `domain-classes/${r.domainCls.domainClsId}`);
    return r;
  }

  @Put(':id')
  @ProjectRole('ADMIN')
  update(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(domainClsInputSchema)) body: z.output<typeof domainClsInputSchema>,
  ): Promise<DomainClsSaveResponse> {
    return this.cls.update(ctxOf(req), id, body, this.auditCtx.current());
  }

  @Delete(':id')
  @ProjectRole('ADMIN')
  remove(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Query(new ZodValidationPipe(forceQuerySchema)) q: z.output<typeof forceQuerySchema>,
  ): Promise<DomainClsDeleteResponse> {
    return this.cls.remove(ctxOf(req), id, q.force === true, this.auditCtx.current());
  }
}

/** 도메인(T6.4). `calculate`는 조회자도 쓸 수 있는 미리보기(§9.3). */
@Controller(`${S}/domains`)
export class DomainsController {
  constructor(
    private readonly domains: DomainService,
    private readonly auditCtx: AuditContext,
  ) {}

  @Get()
  @ProjectRole('VIEWER')
  list(
    @Req() req: Request,
    @Query(new ZodValidationPipe(domainListQuerySchema)) q: z.output<typeof domainListQuerySchema>,
  ): Promise<DomainPage> {
    return this.domains.list(ctxOf(req), q);
  }

  @Post('calculate')
  @ProjectRole('VIEWER')
  @HttpCode(200)
  calculate(
    @Req() req: Request,
    @Body(new ZodValidationPipe(domainCalculateSchema))
    body: z.output<typeof domainCalculateSchema>,
  ): Promise<DomainCalcResult> {
    return this.domains.calculate(ctxOf(req), body);
  }

  @Post('recalculate')
  @ProjectRole('ADMIN')
  @HttpCode(200)
  recalculate(
    @Req() req: Request,
    @Body(new ZodValidationPipe(domainRecalculateSchema))
    body: z.output<typeof domainRecalculateSchema>,
  ): Promise<DomainRecalcResponse> {
    return this.domains.recalculate(ctxOf(req), body.scope, this.auditCtx.current());
  }

  @Get(':id')
  @ProjectRole('VIEWER')
  detail(@Req() req: Request, @Param('id', ParseIntPipe) id: number): Promise<DomainDetail> {
    return this.domains.detail(ctxOf(req), id);
  }

  @Post()
  @ProjectRole('ADMIN')
  async create(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(domainInputSchema)) body: z.output<typeof domainInputSchema>,
  ): Promise<DomainSaveResponse> {
    const r = await this.domains.create(ctxOf(req), body, this.auditCtx.current());
    created(res, req, `domains/${r.domain.domainId}`);
    return r;
  }

  @Put(':id')
  @ProjectRole('ADMIN')
  update(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(domainInputSchema)) body: z.output<typeof domainInputSchema>,
  ): Promise<DomainSaveResponse> {
    return this.domains.update(ctxOf(req), id, body, this.auditCtx.current());
  }

  @Delete(':id')
  @ProjectRole('ADMIN')
  remove(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ unlinkedColumns: number }> {
    return this.domains.remove(ctxOf(req), id, this.auditCtx.current());
  }
}

/** 코드구분·코드(T6.5). */
@Controller(`${S}/code-classes`)
export class CodeClassesController {
  constructor(
    private readonly codes: CodeService,
    private readonly auditCtx: AuditContext,
  ) {}

  @Get()
  @ProjectRole('VIEWER')
  list(
    @Req() req: Request,
    @Query(new ZodValidationPipe(codeClsListQuerySchema))
    q: z.output<typeof codeClsListQuerySchema>,
  ): Promise<Page<CodeClsItem>> {
    return this.codes.listClasses(ctxOf(req), q);
  }

  @Get(':id')
  @ProjectRole('VIEWER')
  detail(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Query(new ZodValidationPipe(codeListQuerySchema)) q: z.output<typeof codeListQuerySchema>,
  ): Promise<CodeClsDetail> {
    return this.codes.detail(ctxOf(req), id, q);
  }

  @Post()
  @ProjectRole('ADMIN')
  async create(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(codeClsInputSchema)) body: z.output<typeof codeClsInputSchema>,
  ): Promise<CodeClsItem> {
    const r = await this.codes.createClass(ctxOf(req), body, this.auditCtx.current());
    created(res, req, `code-classes/${r.codeClsId}`);
    return r;
  }

  @Put(':id')
  @ProjectRole('ADMIN')
  update(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(codeClsInputSchema)) body: z.output<typeof codeClsInputSchema>,
  ): Promise<CodeClsItem> {
    return this.codes.updateClass(ctxOf(req), id, body, this.auditCtx.current());
  }

  @Delete(':id')
  @ProjectRole('ADMIN')
  remove(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<CodeClsDeleteResponse> {
    return this.codes.removeClass(ctxOf(req), id, this.auditCtx.current());
  }

  @Get(':id/codes')
  @ProjectRole('VIEWER')
  codeList(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Query(new ZodValidationPipe(codeListQuerySchema)) q: z.output<typeof codeListQuerySchema>,
  ): Promise<CodeItem[]> {
    return this.codes.detail(ctxOf(req), id, q).then((d) => d.codes);
  }

  @Post(':id/codes')
  @ProjectRole('ADMIN')
  async createCode(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(codeInputSchema)) body: z.output<typeof codeInputSchema>,
  ): Promise<CodeItem> {
    const r = await this.codes.createCode(ctxOf(req), id, body, this.auditCtx.current());
    created(res, req, `code-classes/${id}/codes/${r.codeId}`);
    return r;
  }

  @Put(':id/codes/:codeId')
  @ProjectRole('ADMIN')
  updateCode(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Param('codeId', ParseIntPipe) codeId: number,
    @Body(new ZodValidationPipe(codeInputSchema)) body: z.output<typeof codeInputSchema>,
  ): Promise<CodeItem> {
    return this.codes.updateCode(ctxOf(req), id, codeId, body, this.auditCtx.current());
  }

  @Delete(':id/codes/:codeId')
  @ProjectRole('ADMIN')
  @HttpCode(204)
  async removeCode(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Param('codeId', ParseIntPipe) codeId: number,
  ): Promise<void> {
    await this.codes.removeCode(ctxOf(req), id, codeId, this.auditCtx.current());
  }
}

/** 기본컬럼 세트·구성(T6.6). */
@Controller(`${S}/default-column-sets`)
export class DefaultColumnSetsController {
  constructor(
    private readonly sets: DefaultColService,
    private readonly auditCtx: AuditContext,
  ) {}

  @Get()
  @ProjectRole('VIEWER')
  list(@Req() req: Request): Promise<DefaultColSetItem[]> {
    return this.sets.list(ctxOf(req));
  }

  @Get(':id')
  @ProjectRole('VIEWER')
  detail(@Req() req: Request, @Param('id', ParseIntPipe) id: number): Promise<DefaultColSetItem> {
    return this.sets.get(ctxOf(req), id);
  }

  @Post()
  @ProjectRole('ADMIN')
  async create(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(defaultColSetInputSchema))
    body: z.output<typeof defaultColSetInputSchema>,
  ): Promise<DefaultColSetItem> {
    const r = await this.sets.create(ctxOf(req), body, this.auditCtx.current());
    created(res, req, `default-column-sets/${r.setId}`);
    return r;
  }

  @Put(':id')
  @ProjectRole('ADMIN')
  update(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(defaultColSetInputSchema))
    body: z.output<typeof defaultColSetInputSchema>,
  ): Promise<DefaultColSetItem> {
    return this.sets.update(ctxOf(req), id, body, this.auditCtx.current());
  }

  @Put(':id/columns')
  @ProjectRole('ADMIN')
  columns(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(defaultColsPutSchema)) body: z.output<typeof defaultColsPutSchema>,
  ): Promise<DefaultColSetItem> {
    return this.sets.putColumns(ctxOf(req), id, body.columns, this.auditCtx.current());
  }

  @Put(':id/default')
  @ProjectRole('ADMIN')
  setDefault(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<DefaultColSetItem> {
    return this.sets.setDefault(ctxOf(req), id, this.auditCtx.current());
  }

  @Delete(':id')
  @ProjectRole('ADMIN')
  @HttpCode(204)
  async remove(@Req() req: Request, @Param('id', ParseIntPipe) id: number): Promise<void> {
    await this.sets.remove(ctxOf(req), id, this.auditCtx.current());
  }
}

/** 감사 로그(T6.8, §8.5). §7.3 `P/standards/**` GET = 조회자 이상(§8.5·§9.3의 "PA"와 다름 — §7.3 채택, CR-05 C3). */
@Controller(`${S}/audit-logs`)
export class AuditLogsController {
  constructor(private readonly logs: AuditLogService) {}

  @Get()
  @ProjectRole('VIEWER')
  list(
    @Req() req: Request,
    @Query(new ZodValidationPipe(auditLogQuerySchema)) q: z.output<typeof auditLogQuerySchema>,
  ): Promise<Page<AuditLogItem>> {
    return this.logs.list(ctxOf(req), q);
  }
}

/** 전역 검색(T6.10) — 현재 프로젝트 범위. */
@Controller('projects/:projectKey/search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @ProjectRole('VIEWER')
  find(
    @Req() req: Request,
    @Query(new ZodValidationPipe(searchQuerySchema)) q: z.output<typeof searchQuerySchema>,
  ): Promise<SearchResponse> {
    return this.search.search(ctxOf(req), q.q);
  }
}
