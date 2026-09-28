import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ForbiddenProblem } from '../../common/problem/problem.exception.js';
import { ALLOW_PW_CHANGE } from '../decorators.js';

/**
 * 강제 비밀번호 변경 가드(§7.3·§7.6). `pw_change_required=true`인 동안 `@AllowDuringPasswordChange()`가 아닌
 * API는 403 `password-change-required`. 인증 전 요청(공개 경로)은 SessionAuthGuard가 이미 걸렀으므로 통과.
 */
@Injectable()
export class PasswordChangeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const user = context.switchToHttp().getRequest<Request>().authUser;
    if (!user?.mustChangePassword) return true;
    const allowed = this.reflector.getAllAndOverride<boolean>(ALLOW_PW_CHANGE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowed) return true;
    throw new ForbiddenProblem(undefined, 'password-change-required');
  }
}
