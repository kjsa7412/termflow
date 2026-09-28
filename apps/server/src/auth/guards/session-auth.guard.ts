import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import { UnauthorizedProblem } from '../../common/problem/problem.exception.js';
import type { Db } from '../../db/client.js';
import { DRIZZLE } from '../../db/db.module.js';
import { tfUser } from '../../db/schema.js';
import { IS_PUBLIC } from '../decorators.js';
import { destroySession } from '../session-util.js';

/**
 * 전역 인증 가드(§2.5.4 SessionAuthGuard). `@Public()`이 아니면 세션 사용자가 있어야 하고,
 * 권한 판정 값은 요청마다 tf_user에서 다시 읽는다. 사용자가 없어졌거나 비활성이면 세션을 지우고 401.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DRIZZLE) private readonly db: Db,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const req = context.switchToHttp().getRequest<Request>();
    const sessionUser = req.session?.user;
    if (!sessionUser) throw new UnauthorizedProblem();
    const [u] = await this.db
      .select({
        id: tfUser.userId,
        loginId: tfUser.loginId,
        userNm: tfUser.userNm,
        isSysAdmin: tfUser.isSysAdmin,
        isActive: tfUser.isActive,
        pwChangeRequired: tfUser.pwChangeRequired,
      })
      .from(tfUser)
      .where(eq(tfUser.userId, sessionUser.id));
    if (!u || !u.isActive || u.loginId !== sessionUser.loginId) {
      await destroySession(req);
      throw new UnauthorizedProblem();
    }
    req.authUser = {
      id: u.id,
      loginId: u.loginId,
      userNm: u.userNm,
      isSysAdmin: u.isSysAdmin,
      mustChangePassword: u.pwChangeRequired,
    };
    return true;
  }
}
