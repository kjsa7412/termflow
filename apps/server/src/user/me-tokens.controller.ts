import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import {
  API_ERROR_CODES,
  apiTokenCreateSchema,
  type ApiTokenCreateResponse,
  type ApiTokenListResponse,
} from '@termflow/shared';
import type { z } from 'zod';
import { ApiTokenService } from '../auth/api-token.service.js';
import { AuditContext } from '../common/audit/audit-context.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { ConflictProblem } from '../common/problem/problem.exception.js';
import type { Env } from '../config/env.schema.js';

/** 외부 연동 엔드포인트 경로(전역 접두어 밖, CR-18 C2). */
export const MCP_PATH = '/mcp';

/**
 * `/api/v1/me/tokens` — 본인 개인 접근 토큰 목록·발급·폐기(CR-18 C3). 세션 로그인 전용
 * (bearerMiddleware가 토큰 요청을 403으로 막는다). 연동이 꺼져 있으면 목록만 보이고 발급은 409.
 */
@Controller('me/tokens')
export class MeTokensController {
  constructor(
    private readonly tokens: ApiTokenService,
    private readonly auditCtx: AuditContext,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private enabled(): boolean {
    return this.config.get('TERMFLOW_MCP_ENABLED', { infer: true }) === 'true';
  }

  @Get()
  async list(@Req() req: Request): Promise<ApiTokenListResponse> {
    return {
      enabled: this.enabled(),
      mcpPath: MCP_PATH,
      items: await this.tokens.list(req.authUser!.id),
    };
  }

  @Post()
  async issue(
    @Req() req: Request,
    @Body(new ZodValidationPipe(apiTokenCreateSchema)) body: z.output<typeof apiTokenCreateSchema>,
  ): Promise<ApiTokenCreateResponse> {
    if (!this.enabled()) {
      throw new ConflictProblem('E_TOKEN_DISABLED', API_ERROR_CODES.E_TOKEN_DISABLED);
    }
    return this.tokens.issue(req.authUser!.id, body, this.auditCtx.current());
  }

  @Delete(':id')
  @HttpCode(204)
  async revoke(@Req() req: Request, @Param('id', ParseIntPipe) id: number): Promise<void> {
    await this.tokens.revoke(req.authUser!.id, id, this.auditCtx.current());
  }
}
