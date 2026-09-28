import { Body, Controller, Get, HttpCode, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { passwordChangeSchema, type MeResponse } from '@termflow/shared';
import type { z } from 'zod';
import { AuditContext } from '../common/audit/audit-context.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { AllowDuringPasswordChange } from '../auth/decorators.js';
import { UserService } from './user.service.js';

/** `/api/v1/me`(T4.5, §9.3) — 로그인 사용자. 강제 비밀번호 변경 중에도 허용(§7.3). */
@Controller('me')
@AllowDuringPasswordChange()
export class MeController {
  constructor(
    private readonly users: UserService,
    private readonly auditCtx: AuditContext,
  ) {}

  @Get()
  me(@Req() req: Request): Promise<MeResponse> {
    return this.users.me(req.authUser!);
  }

  @Put('password')
  @HttpCode(204)
  async changePassword(
    @Req() req: Request,
    @Body(new ZodValidationPipe(passwordChangeSchema)) body: z.output<typeof passwordChangeSchema>,
  ): Promise<void> {
    const user = req.authUser!;
    await this.users.changePassword(
      user,
      body.currentPassword,
      body.newPassword,
      this.auditCtx.as(user.loginId),
      req.sessionID,
    );
  }
}
