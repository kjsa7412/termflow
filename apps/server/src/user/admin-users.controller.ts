import {
  Body,
  Controller,
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
  pageQuerySchema,
  userActiveSchema,
  userCreateSchema,
  userSearchQuerySchema,
  userUpdateSchema,
  type AdminUserCreateResponse,
  type AdminUserItem,
  type AdminUserPage,
  type PasswordResetResponse,
} from '@termflow/shared';
import type { z } from 'zod';
import { AuditContext } from '../common/audit/audit-context.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { SysAdmin } from '../auth/decorators.js';
import { UserService } from './user.service.js';

const listQuerySchema = userSearchQuerySchema.extend(pageQuerySchema.shape);

/**
 * `/api/v1/admin/users/**`(T4.6, §9.3) — 시스템 관리자 전용. 임시 비밀번호는 생성·초기화 응답에만 1회 담기고
 * 로그(pino redact `temporaryPassword`)·감사에는 남지 않는다.
 */
@Controller('admin/users')
@SysAdmin()
export class AdminUsersController {
  constructor(
    private readonly users: UserService,
    private readonly auditCtx: AuditContext,
  ) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(listQuerySchema)) q: z.output<typeof listQuerySchema>,
  ): Promise<AdminUserPage> {
    return this.users.list({
      q: q.q ?? undefined,
      status: q.status,
      sysAdmin: q.sysAdmin,
      page: q.page,
      size: q.size,
    });
  }

  @Post()
  async create(
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(userCreateSchema)) body: z.output<typeof userCreateSchema>,
  ): Promise<AdminUserCreateResponse> {
    const r = await this.users.create(body, this.auditCtx.current());
    res.status(201).location(`${API_PREFIX}/admin/users/${r.user.id}`);
    return r;
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number): Promise<AdminUserItem> {
    return this.users.get(id);
  }

  @Put(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(userUpdateSchema)) body: z.output<typeof userUpdateSchema>,
  ): Promise<AdminUserItem> {
    return this.users.update(id, body, this.auditCtx.current());
  }

  @Put(':id/active')
  setActive(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(userActiveSchema)) body: z.output<typeof userActiveSchema>,
  ): Promise<AdminUserItem> {
    return this.users.setActive(id, body.isActive, req.authUser!, this.auditCtx.current());
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  resetPassword(@Param('id', ParseIntPipe) id: number): Promise<PasswordResetResponse> {
    return this.users.resetPassword(id, this.auditCtx.current());
  }

  @Post(':id/unlock')
  @HttpCode(200)
  unlock(@Param('id', ParseIntPipe) id: number): Promise<AdminUserItem> {
    return this.users.unlock(id, this.auditCtx.current());
  }
}
