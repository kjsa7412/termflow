import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { and, eq } from 'drizzle-orm';
import type { Request } from 'express';
import {
  API_ERROR_CODES,
  MEMBER_ROLE_RANK,
  type MemberRole,
  type ProjectKind,
  type ProjectStatus,
} from '@termflow/shared';
import {
  ConflictProblem,
  ForbiddenProblem,
  NotFoundProblem,
  UnauthorizedProblem,
} from '../../common/problem/problem.exception.js';
import type { Db } from '../../db/client.js';
import { DRIZZLE } from '../../db/db.module.js';
import { tfProject, tfProjectMember } from '../../db/schema.js';
import { PROJECT_ROLE } from '../decorators.js';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PROJECT_NOT_FOUND = '프로젝트를 찾을 수 없습니다';

/**
 * `@ProjectRole(role)` — 프로젝트 범위 권한(§7.2·§7.3, CR-01). 요청당 1회 조회해 `req.projectCtx`를 채운다.
 *  - 시스템 관리자: 모든 프로젝트·템플릿에서 ADMIN
 *  - 그 외: 멤버십 역할. 비멤버·없는 키·템플릿은 **404**(존재 노출 방지)
 *  - 역할 부족 403, 보관 프로젝트(또는 비관리자의 템플릿)에 쓰기 409 `E_PROJECT_READONLY`
 */
@Injectable()
export class ProjectRoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DRIZZLE) private readonly db: Db,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<MemberRole>(PROJECT_ROLE, [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest<Request>();
    const user = req.authUser;
    if (!user) throw new UnauthorizedProblem();
    const key = String(req.params['projectKey'] ?? '');
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(key)) throw new NotFoundProblem(PROJECT_NOT_FOUND);

    const [row] = await this.db
      .select({
        projectId: tfProject.projectId,
        kind: tfProject.kind,
        status: tfProject.status,
        memberRole: tfProjectMember.memberRole,
      })
      .from(tfProject)
      .leftJoin(
        tfProjectMember,
        and(
          eq(tfProjectMember.projectId, tfProject.projectId),
          eq(tfProjectMember.userId, user.id),
        ),
      )
      .where(eq(tfProject.projectKey, key));
    if (!row) throw new NotFoundProblem(PROJECT_NOT_FOUND);
    const kind = row.kind as ProjectKind;
    if (kind === 'TEMPLATE' && !user.isSysAdmin) throw new NotFoundProblem(PROJECT_NOT_FOUND);
    const role: MemberRole | null = user.isSysAdmin
      ? 'ADMIN'
      : (row.memberRole as MemberRole | null);
    if (!role) throw new NotFoundProblem(PROJECT_NOT_FOUND);
    if (required && MEMBER_ROLE_RANK[role] < MEMBER_ROLE_RANK[required])
      throw new ForbiddenProblem();

    const status = row.status as ProjectStatus;
    if (!READ_METHODS.has(req.method)) {
      if (status === 'ARCHIVED' || (kind === 'TEMPLATE' && !user.isSysAdmin)) {
        throw new ConflictProblem('E_PROJECT_READONLY', API_ERROR_CODES.E_PROJECT_READONLY);
      }
    }
    req.projectCtx = {
      projectId: row.projectId,
      projectKey: key,
      kind,
      status,
      role,
      sysAdmin: user.isSysAdmin,
    };
    return true;
  }
}
