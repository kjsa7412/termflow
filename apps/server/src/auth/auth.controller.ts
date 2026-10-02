import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { loginSchema, type CsrfResponse, type LoginResponse } from '@termflow/shared';
import type { z } from 'zod';
import { clientIp } from '../common/audit/audit.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { AuthService } from './auth.service.js';
import { AllowDuringPasswordChange, Public } from './decorators.js';
import { COOKIE_NAMES, CSRF_UTILS, type CookieNames, type CsrfUtils } from './http-security.js';
import { destroySession, regenerateSession, saveSession } from './session-util.js';

/**
 * `/api/v1/auth/*`(T4.2, 설계서 §7.1·§7.4, CR-02 C6·C7).
 *  - GET `/auth/csrf`: 익명 세션에 표식을 저장해 세션 ID를 고정한 뒤 토큰 발급(쿠키 + 본문)
 *  - POST `/auth/login`(form 또는 JSON): 성공 시 `session.regenerate()`(세션 고정 방지) → 새 CSRF 토큰
 *  - POST `/auth/logout`: 세션 삭제 + 쿠키 삭제 → 204
 */
@Controller('auth')
@AllowDuringPasswordChange()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(CSRF_UTILS) private readonly csrf: CsrfUtils,
    @Inject(COOKIE_NAMES) private readonly cookies: CookieNames,
  ) {}

  @Public()
  @Get('csrf')
  async issue(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CsrfResponse> {
    if (!req.session.user) req.session.anon = true;
    await saveSession(req);
    return { token: this.csrf.generateCsrfToken(req, res, { overwrite: true }) };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(loginSchema)) body: z.output<typeof loginSchema>,
  ): Promise<LoginResponse> {
    const result = await this.auth.login(body.loginId, body.password, clientIp(req));
    await regenerateSession(req);
    req.session.user = result.user;
    await saveSession(req);
    const csrfToken = this.csrf.generateCsrfToken(req, res, { overwrite: true });
    return { user: result.user, mustChangePassword: result.mustChangePassword, csrfToken };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await destroySession(req);
    res.clearCookie(this.cookies.session, { path: '/' });
  }
}
