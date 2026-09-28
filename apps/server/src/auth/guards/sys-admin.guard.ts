import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ForbiddenProblem, UnauthorizedProblem } from '../../common/problem/problem.exception.js';

/** `@SysAdmin()` — 시스템 관리자만(§7.2). 로그인했지만 권한이 없으면 403 forbidden. */
@Injectable()
export class SysAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest<Request>().authUser;
    if (!user) throw new UnauthorizedProblem();
    if (!user.isSysAdmin) throw new ForbiddenProblem();
    return true;
  }
}
