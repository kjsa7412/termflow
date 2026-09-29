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
  adminProjectQuerySchema,
  bizAreaInputSchema,
  checkKeyQuerySchema,
  confirmKeySchema,
  copyPreviewSchema,
  memberCandidateQuerySchema,
  memberInputSchema,
  memberRoleSchema,
  projectCreateSchema,
  projectListQuerySchema,
  projectSettingsSchema,
  projectStatusSchema,
  templatePublishSchema,
  type AdminProjectItem,
  type BizAreaDeletePreview,
  type BizAreaDeleteResponse,
  type BizAreaItem,
  type CopyLogItem,
  type CopyPreviewResponse,
  type CopySourcesResponse,
  type MemberCandidate,
  type MemberItem,
  type ProjectCard,
  type ProjectCreateResponse,
  type ProjectHome,
  type ProjectSettings,
  type TemplateItem,
} from '@termflow/shared';
import type { z } from 'zod';
import { ProjectRole, SysAdmin } from '../auth/decorators.js';
import { AuditContext } from '../common/audit/audit-context.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import type { ProjectCtx } from '../common/project-context.js';
import { BizAreaService } from './biz-area.service.js';
import { MemberService } from './member.service.js';
import { ProjectService } from './project.service.js';
import { TemplateService } from './template.service.js';

const ctxOf = (req: Request): ProjectCtx => req.projectCtx!;

/**
 * `/api/v1/projects/**`(T5.1·T5.4, §9.3). 전역 경로(목록·키 검사·원본 후보·미리보기·생성)를 `:projectKey`보다 먼저 등록한다.
 * `P` 경로는 ProjectRoleGuard가 `req.projectCtx`를 채운다(비멤버 404, 보관·비관리자 템플릿 쓰기 409).
 */
@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projects: ProjectService,
    private readonly auditCtx: AuditContext,
  ) {}

  @Get()
  list(
    @Req() req: Request,
    @Query(new ZodValidationPipe(projectListQuerySchema))
    q: z.output<typeof projectListQuerySchema>,
  ): Promise<ProjectCard[]> {
    return this.projects.list(req.authUser!, q);
  }

  @Get('check-key')
  @SysAdmin()
  checkKey(
    @Query(new ZodValidationPipe(checkKeyQuerySchema)) q: z.output<typeof checkKeyQuerySchema>,
  ): Promise<{ available: boolean; reason?: string }> {
    return this.projects.checkKey(q.key);
  }

  @Get('copy-sources')
  copySources(@Req() req: Request): Promise<CopySourcesResponse> {
    return this.projects.copySources(req.authUser!);
  }

  @Post('copy-preview')
  @SysAdmin()
  @HttpCode(200)
  preview(
    @Body(new ZodValidationPipe(copyPreviewSchema)) body: z.output<typeof copyPreviewSchema>,
  ): Promise<CopyPreviewResponse> {
    return this.projects.preview(body.imports);
  }

  @Post()
  @SysAdmin()
  async create(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(projectCreateSchema)) body: z.output<typeof projectCreateSchema>,
  ): Promise<ProjectCreateResponse> {
    const r = await this.projects.create(body, req.authUser!, this.auditCtx.current());
    res.status(201).location(`${API_PREFIX}/projects/${r.projectKey}`);
    return r;
  }

  @Get(':projectKey')
  @ProjectRole('VIEWER')
  home(@Req() req: Request): Promise<ProjectHome> {
    return this.projects.home(ctxOf(req));
  }

  @Get(':projectKey/settings')
  @ProjectRole('VIEWER')
  settings(@Req() req: Request): Promise<ProjectSettings> {
    return this.projects.settings(ctxOf(req));
  }

  @Put(':projectKey/settings')
  @ProjectRole('ADMIN')
  updateSettings(
    @Req() req: Request,
    @Body(new ZodValidationPipe(projectSettingsSchema))
    body: z.output<typeof projectSettingsSchema>,
  ): Promise<ProjectSettings> {
    return this.projects.updateSettings(ctxOf(req), body, this.auditCtx.current());
  }

  @Get(':projectKey/copy-log')
  @ProjectRole('ADMIN')
  copyLog(@Req() req: Request): Promise<CopyLogItem[]> {
    return this.projects.copyLog(ctxOf(req));
  }
}

/** `P/members/**`, `P/member-candidates`(T5.6). */
@Controller('projects/:projectKey')
export class MembersController {
  constructor(
    private readonly members: MemberService,
    private readonly auditCtx: AuditContext,
  ) {}

  @Get('members')
  @ProjectRole('VIEWER')
  list(@Req() req: Request): Promise<MemberItem[]> {
    return this.members.list(ctxOf(req));
  }

  @Get('member-candidates')
  @ProjectRole('ADMIN')
  candidates(
    @Req() req: Request,
    @Query(new ZodValidationPipe(memberCandidateQuerySchema))
    q: z.output<typeof memberCandidateQuerySchema>,
  ): Promise<MemberCandidate[]> {
    return this.members.candidates(ctxOf(req), q.q);
  }

  @Post('members')
  @ProjectRole('ADMIN')
  async add(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(memberInputSchema)) body: z.output<typeof memberInputSchema>,
  ): Promise<MemberItem> {
    const ctx = ctxOf(req);
    const m = await this.members.add(ctx, body.userId, body.role, this.auditCtx.current());
    res.status(201).location(`${API_PREFIX}/projects/${ctx.projectKey}/members/${m.userId}`);
    return m;
  }

  @Put('members/:userId')
  @ProjectRole('ADMIN')
  update(
    @Req() req: Request,
    @Param('userId', ParseIntPipe) userId: number,
    @Body(new ZodValidationPipe(memberRoleSchema)) body: z.output<typeof memberRoleSchema>,
  ): Promise<MemberItem> {
    return this.members.update(ctxOf(req), userId, body.role, this.auditCtx.current());
  }

  @Delete('members/:userId')
  @ProjectRole('ADMIN')
  @HttpCode(204)
  async remove(@Req() req: Request, @Param('userId', ParseIntPipe) userId: number): Promise<void> {
    await this.members.remove(ctxOf(req), userId, this.auditCtx.current());
  }
}

/** `P/biz-areas/**`(T5.7). */
@Controller('projects/:projectKey/biz-areas')
export class BizAreasController {
  constructor(
    private readonly bizAreas: BizAreaService,
    private readonly auditCtx: AuditContext,
  ) {}

  @Get()
  @ProjectRole('VIEWER')
  list(@Req() req: Request): Promise<BizAreaItem[]> {
    return this.bizAreas.list(ctxOf(req));
  }

  @Post()
  @ProjectRole('ADMIN')
  async create(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(bizAreaInputSchema)) body: z.output<typeof bizAreaInputSchema>,
  ): Promise<BizAreaItem> {
    const ctx = ctxOf(req);
    const b = await this.bizAreas.create(ctx, body, this.auditCtx.current());
    res.status(201).location(`${API_PREFIX}/projects/${ctx.projectKey}/biz-areas/${b.bizAreaId}`);
    return b;
  }

  @Get(':id/delete-preview')
  @ProjectRole('ADMIN')
  deletePreview(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<BizAreaDeletePreview> {
    return this.bizAreas.deletePreview(ctxOf(req), id);
  }

  @Put(':id')
  @ProjectRole('ADMIN')
  update(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(bizAreaInputSchema)) body: z.output<typeof bizAreaInputSchema>,
  ): Promise<BizAreaItem> {
    return this.bizAreas.update(ctxOf(req), id, body, this.auditCtx.current());
  }

  @Delete(':id')
  @ProjectRole('ADMIN')
  remove(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<BizAreaDeleteResponse> {
    return this.bizAreas.remove(ctxOf(req), id, this.auditCtx.current());
  }
}

/** `/admin/projects/**`(T5.5) — 시스템 관리자. */
@Controller('admin/projects')
@SysAdmin()
export class AdminProjectsController {
  constructor(
    private readonly projects: ProjectService,
    private readonly auditCtx: AuditContext,
  ) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(adminProjectQuerySchema))
    q: z.output<typeof adminProjectQuerySchema>,
  ): Promise<AdminProjectItem[]> {
    return this.projects.adminList(q);
  }

  @Put(':key/status')
  async setStatus(
    @Param('key') key: string,
    @Body(new ZodValidationPipe(projectStatusSchema)) body: z.output<typeof projectStatusSchema>,
  ): Promise<AdminProjectItem> {
    await this.projects.setStatus(key, 'PROJECT', body.status, this.auditCtx.current());
    return (await this.projects.adminList({})).find((p) => p.key === key)!;
  }

  @Delete(':key')
  @HttpCode(204)
  async remove(
    @Param('key') key: string,
    @Body(new ZodValidationPipe(confirmKeySchema)) body: z.output<typeof confirmKeySchema>,
  ): Promise<void> {
    await this.projects.deleteProject(key, body.confirmKey, this.auditCtx.current());
  }
}

/** `/admin/templates/**`(T5.8) — 시스템 관리자. */
@Controller('admin/templates')
@SysAdmin()
export class AdminTemplatesController {
  constructor(
    private readonly templates: TemplateService,
    private readonly projects: ProjectService,
    private readonly auditCtx: AuditContext,
  ) {}

  @Get()
  list(): Promise<TemplateItem[]> {
    return this.templates.list();
  }

  @Post()
  async publish(
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(templatePublishSchema))
    body: z.output<typeof templatePublishSchema>,
  ): Promise<ProjectCreateResponse> {
    const r = await this.templates.publish(body, this.auditCtx.current());
    res.status(201).location(`${API_PREFIX}/admin/templates/${r.projectKey}`);
    return r;
  }

  @Put(':key/status')
  async setStatus(
    @Param('key') key: string,
    @Body(new ZodValidationPipe(projectStatusSchema)) body: z.output<typeof projectStatusSchema>,
  ): Promise<TemplateItem> {
    await this.projects.setStatus(key, 'TEMPLATE', body.status, this.auditCtx.current());
    return (await this.templates.list()).find((t) => t.key === key)!;
  }

  @Delete(':key')
  @HttpCode(204)
  async remove(
    @Param('key') key: string,
    @Body(new ZodValidationPipe(confirmKeySchema)) body: z.output<typeof confirmKeySchema>,
  ): Promise<void> {
    await this.templates.delete(key, body.confirmKey, this.auditCtx.current());
  }
}
