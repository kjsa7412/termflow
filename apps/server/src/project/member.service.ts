import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import {
  API_ERROR_CODES,
  type MemberCandidate,
  type MemberItem,
  type MemberRole,
} from '@termflow/shared';
import type { Audit } from '../common/audit/audit.js';
import {
  ConflictProblem,
  NotFoundProblem,
  ValidationProblem,
} from '../common/problem/problem.exception.js';
import type { ProjectCtx } from '../common/project-context.js';
import { insertAudited, updateAudited } from '../db/audit.js';
import type { Db } from '../db/client.js';
import { DRIZZLE } from '../db/db.module.js';
import { tfProjectMember, tfUser } from '../db/schema.js';
import { isoTs, likePattern, rowsOf } from './sql-util.js';

/**
 * 프로젝트 멤버(T5.6, 설계서 §4.7·§7.2·§9.3). 프로젝트마다 ADMIN 멤버 1명 이상 — 마지막 관리자의 강등·제거는
 * 409 `E_LAST_PROJECT_ADMIN`(시스템 관리자는 멤버십과 별개라 멤버가 아니면 인원에 들지 않는다).
 * 템플릿에는 멤버가 없다(§4.6): 409 `E_TEMPLATE_NO_TABLES`.
 */
@Injectable()
export class MemberService {
  private readonly logger = new Logger('Members');

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private assertProject(ctx: ProjectCtx): void {
    if (ctx.kind === 'TEMPLATE') {
      throw new ConflictProblem('E_TEMPLATE_NO_TABLES', API_ERROR_CODES.E_TEMPLATE_NO_TABLES);
    }
  }

  async list(ctx: ProjectCtx): Promise<MemberItem[]> {
    this.assertProject(ctx);
    const rows = await rowsOf<{
      user_id: number;
      login_id: string;
      user_nm: string;
      role: MemberRole;
      is_sys_admin: boolean;
      is_active: boolean;
      added_at: string;
      last_login_at: string | null;
    }>(
      this.db,
      sql`select u.user_id, u.login_id, u.user_nm, m.member_role role, u.is_sys_admin, u.is_active,
                 ${isoTs(sql`m.created_at`)} added_at, ${isoTs(sql`u.last_login_at`)} last_login_at
            from tf_project_member m join tf_user u on u.user_id = m.user_id
           where m.project_id = ${ctx.projectId}
           order by case m.member_role when 'ADMIN' then 1 when 'EDITOR' then 2 else 3 end, u.user_nm, u.login_id`,
    );
    return rows.map((r) => ({
      userId: r.user_id,
      loginId: r.login_id,
      userNm: r.user_nm,
      role: r.role,
      isSysAdmin: r.is_sys_admin,
      isActive: r.is_active,
      addedAt: r.added_at,
      lastLoginAt: r.last_login_at,
    }));
  }

  /** 사용자 검색(활성 계정, 20건). 이미 멤버면 isMember=true(화면은 선택 불가로 표시, 목업 12). */
  async candidates(ctx: ProjectCtx, q: string): Promise<MemberCandidate[]> {
    this.assertProject(ctx);
    const rows = await rowsOf<{
      user_id: number;
      login_id: string;
      user_nm: string;
      is_sys_admin: boolean;
      is_member: boolean;
    }>(
      this.db,
      sql`select u.user_id, u.login_id, u.user_nm, u.is_sys_admin,
                 exists (select 1 from tf_project_member m where m.project_id = ${ctx.projectId} and m.user_id = u.user_id) is_member
            from tf_user u
           where u.is_active
             and (${q} = '' or u.user_nm ilike ${likePattern(q)} or u.login_id ilike ${likePattern(q)})
           order by is_member, u.user_nm, u.login_id limit 20`,
    );
    return rows.map((r) => ({
      userId: r.user_id,
      loginId: r.login_id,
      userNm: r.user_nm,
      isSysAdmin: r.is_sys_admin,
      isMember: r.is_member,
    }));
  }

  async add(ctx: ProjectCtx, userId: number, role: MemberRole, a: Audit): Promise<MemberItem> {
    this.assertProject(ctx);
    const [u] = await this.db
      .select({ id: tfUser.userId, active: tfUser.isActive, loginId: tfUser.loginId })
      .from(tfUser)
      .where(eq(tfUser.userId, userId));
    if (!u) throw new NotFoundProblem('사용자를 찾을 수 없습니다');
    if (!u.active) {
      throw new ValidationProblem([
        {
          code: 'E_USER_INACTIVE',
          target: 'field',
          field: 'userId',
          message: API_ERROR_CODES.E_USER_INACTIVE,
        },
      ]);
    }
    const [row] = await insertAudited(
      this.db,
      tfProjectMember,
      { projectId: ctx.projectId, userId, memberRole: role },
      a,
    )
      .onConflictDoNothing()
      .returning({ userId: tfProjectMember.userId });
    if (!row) throw new ConflictProblem('E_MEMBER_DUP', API_ERROR_CODES.E_MEMBER_DUP);
    this.logger.log(`멤버 추가: ${ctx.projectKey} ${u.loginId}(${role}) by ${a.actor}`);
    return this.get(ctx, userId);
  }

  async update(ctx: ProjectCtx, userId: number, role: MemberRole, a: Audit): Promise<MemberItem> {
    this.assertProject(ctx);
    const current = await this.currentRole(ctx, userId);
    if (current === 'ADMIN' && role !== 'ADMIN') await this.assertNotLastAdmin(ctx, userId);
    if (current !== role) {
      await updateAudited(this.db, tfProjectMember, { memberRole: role }, a).where(
        and(eq(tfProjectMember.projectId, ctx.projectId), eq(tfProjectMember.userId, userId)),
      );
    }
    return this.get(ctx, userId);
  }

  async remove(ctx: ProjectCtx, userId: number, a: Audit): Promise<void> {
    this.assertProject(ctx);
    const current = await this.currentRole(ctx, userId);
    if (current === 'ADMIN') await this.assertNotLastAdmin(ctx, userId);
    await this.db
      .delete(tfProjectMember)
      .where(and(eq(tfProjectMember.projectId, ctx.projectId), eq(tfProjectMember.userId, userId)));
    this.logger.log(`멤버 제외: ${ctx.projectKey} user ${userId} by ${a.actor}`);
  }

  private async get(ctx: ProjectCtx, userId: number): Promise<MemberItem> {
    const m = (await this.list(ctx)).find((x) => x.userId === userId);
    if (!m) throw new NotFoundProblem('멤버를 찾을 수 없습니다');
    return m;
  }

  private async currentRole(ctx: ProjectCtx, userId: number): Promise<MemberRole> {
    const [m] = await this.db
      .select({ role: tfProjectMember.memberRole })
      .from(tfProjectMember)
      .where(and(eq(tfProjectMember.projectId, ctx.projectId), eq(tfProjectMember.userId, userId)));
    if (!m) throw new NotFoundProblem('멤버를 찾을 수 없습니다');
    return m.role as MemberRole;
  }

  private async assertNotLastAdmin(ctx: ProjectCtx, userId: number): Promise<void> {
    const others = await this.db.$count(
      tfProjectMember,
      and(
        eq(tfProjectMember.projectId, ctx.projectId),
        eq(tfProjectMember.memberRole, 'ADMIN'),
        ne(tfProjectMember.userId, userId),
      ),
    );
    if (others === 0) {
      throw new ConflictProblem('E_LAST_PROJECT_ADMIN', API_ERROR_CODES.E_LAST_PROJECT_ADMIN);
    }
  }
}
