import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, count, eq, ilike, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import type pg from 'pg';
import {
  API_ERROR_CODES,
  PASSWORD_VIOLATION_MESSAGES,
  checkPasswordPolicy,
  type AdminUserItem,
  type AdminUserPage,
  type MemberRole,
  type MeResponse,
  type MyProject,
  type ProjectKind,
  type ProjectStatus,
  type UserStatusFilter,
  type ValidationIssue,
} from '@termflow/shared';
import type { Audit } from '../common/audit/audit.js';
import {
  ConflictProblem,
  NotFoundProblem,
  ValidationProblem,
} from '../common/problem/problem.exception.js';
import { insertAudited, updateAudited } from '../db/audit.js';
import type { Db } from '../db/client.js';
import { DRIZZLE, PG_POOL } from '../db/db.module.js';
import { tfProject, tfProjectMember, tfUser } from '../db/schema.js';
import type { AuthUser } from '../auth/session-user.js';
import { generateTemporaryPassword, hashPassword, verifyPassword } from '../auth/password.js';
import { deleteUserSessions } from '../auth/session-util.js';

const iso = (v: string | null): string | null => (v ? v.replace(' ', 'T') : null);

export interface UserListQuery {
  q?: string | undefined;
  status: UserStatusFilter;
  sysAdmin: boolean;
  page: number;
  size: number;
}

/**
 * 내 계정(`/me`, T4.5)·사용자 관리(`/admin/users`, T4.6) 서비스. 비밀번호 평문은 인자로만 다루고
 * 로그·감사·응답(임시 비밀번호 1회 제외)에 남기지 않는다.
 */
@Injectable()
export class UserService {
  private readonly logger = new Logger('Users');

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
  ) {}

  // ── 내 계정 ────────────────────────────────────────────────────────────
  async me(user: AuthUser): Promise<MeResponse> {
    return {
      user: {
        id: user.id,
        loginId: user.loginId,
        userNm: user.userNm,
        isSysAdmin: user.isSysAdmin,
      },
      mustChangePassword: user.mustChangePassword,
      projects: await this.myProjects(user),
    };
  }

  /** 소속 프로젝트(시스템 관리자는 전체, 역할 ADMIN). 템플릿은 시스템 관리자에게만. */
  async myProjects(user: Pick<AuthUser, 'id' | 'isSysAdmin'>): Promise<MyProject[]> {
    const rows = user.isSysAdmin
      ? await this.db
          .select({
            key: tfProject.projectKey,
            nm: tfProject.projectNm,
            kind: tfProject.kind,
            status: tfProject.status,
            role: sql<string>`'ADMIN'`,
          })
          .from(tfProject)
          .orderBy(asc(tfProject.kind), asc(tfProject.projectKey))
      : await this.db
          .select({
            key: tfProject.projectKey,
            nm: tfProject.projectNm,
            kind: tfProject.kind,
            status: tfProject.status,
            role: tfProjectMember.memberRole,
          })
          .from(tfProjectMember)
          .innerJoin(tfProject, eq(tfProject.projectId, tfProjectMember.projectId))
          .where(and(eq(tfProjectMember.userId, user.id), eq(tfProject.kind, 'PROJECT')))
          .orderBy(asc(tfProject.projectKey));
    return rows.map((r) => ({
      key: r.key,
      nm: r.nm,
      kind: r.kind as ProjectKind,
      status: r.status as ProjectStatus,
      role: r.role as MemberRole,
    }));
  }

  /**
   * 비밀번호 변경(§7.6): 현재 비밀번호 확인 → 정책(8~64자, 2종 이상, ID 미포함) → 직전(현재) 비밀번호와 동일 금지.
   * 성공하면 강제 변경 해제, 이 사용자의 **다른** 세션을 모두 끊는다.
   */
  async changePassword(
    user: AuthUser,
    currentPassword: string,
    newPassword: string,
    a: Audit,
    currentSid: string,
  ): Promise<void> {
    const [u] = await this.db
      .select({ hash: tfUser.passwordHash })
      .from(tfUser)
      .where(eq(tfUser.userId, user.id));
    if (!u) throw new NotFoundProblem();
    if (!(await verifyPassword(currentPassword, u.hash))) {
      throw new ValidationProblem([
        {
          code: 'E_PW_CURRENT_MISMATCH',
          target: 'field',
          field: 'currentPassword',
          message: API_ERROR_CODES.E_PW_CURRENT_MISMATCH,
        },
      ]);
    }
    const errors = passwordIssues(newPassword, user.loginId, 'newPassword');
    if (errors.length === 0 && (await verifyPassword(newPassword, u.hash))) {
      errors.push({
        code: 'PW_SAME_AS_PREVIOUS',
        target: 'field',
        field: 'newPassword',
        message: PASSWORD_VIOLATION_MESSAGES.PW_SAME_AS_PREVIOUS,
      });
    }
    if (errors.length > 0) throw new ValidationProblem(errors);
    await updateAudited(
      this.db,
      tfUser,
      { passwordHash: await hashPassword(newPassword), pwChangeRequired: false },
      a,
    ).where(eq(tfUser.userId, user.id));
    const killed = await deleteUserSessions(this.pool, user.id, currentSid);
    this.logger.log(`비밀번호 변경: ${user.loginId}(다른 세션 ${killed}개 종료)`);
  }

  // ── 사용자 관리(시스템 관리자) ──────────────────────────────────────────
  async list(query: UserListQuery): Promise<AdminUserPage> {
    const lockedExpr = sql<boolean>`coalesce(${tfUser.lockedUntil} > CURRENT_TIMESTAMP, false)`;
    const filters: SQL[] = [];
    if (query.q) {
      const like = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      filters.push(
        or(ilike(tfUser.userNm, like), ilike(tfUser.loginId, like), ilike(tfUser.email, like))!,
      );
    }
    if (query.sysAdmin) filters.push(eq(tfUser.isSysAdmin, true));
    const base = filters.length > 0 ? and(...filters) : undefined;
    const statusFilter: Record<UserStatusFilter, SQL | undefined> = {
      ALL: undefined,
      ACTIVE: sql`${tfUser.isActive} and not ${lockedExpr} and not ${tfUser.pwChangeRequired}`,
      PW_PENDING: sql`${tfUser.isActive} and ${tfUser.pwChangeRequired}`,
      LOCKED: sql`${tfUser.isActive} and ${lockedExpr}`,
      INACTIVE: sql`not ${tfUser.isActive}`,
    };
    const where = and(base, statusFilter[query.status]);

    const [c] = await this.db
      .select({
        all: count(),
        active: sql<number>`count(*) filter (where ${statusFilter.ACTIVE})::int`,
        pwPending: sql<number>`count(*) filter (where ${statusFilter.PW_PENDING})::int`,
        locked: sql<number>`count(*) filter (where ${statusFilter.LOCKED})::int`,
        inactive: sql<number>`count(*) filter (where ${statusFilter.INACTIVE})::int`,
        sysAdmin: sql<number>`count(*) filter (where ${tfUser.isSysAdmin})::int`,
      })
      .from(tfUser)
      .where(base);
    const [t] = await this.db.select({ n: count() }).from(tfUser).where(where);
    const rows = await this.db
      .select(userColumns(lockedExpr))
      .from(tfUser)
      .where(where)
      .orderBy(asc(tfUser.userNm), asc(tfUser.loginId))
      .limit(query.size)
      .offset((query.page - 1) * query.size);
    const items = await this.withProjects(rows);
    return {
      items,
      page: query.page,
      size: query.size,
      total: t?.n ?? 0,
      counts: {
        all: c?.all ?? 0,
        active: c?.active ?? 0,
        pwPending: c?.pwPending ?? 0,
        locked: c?.locked ?? 0,
        inactive: c?.inactive ?? 0,
        sysAdmin: c?.sysAdmin ?? 0,
      },
    };
  }

  async get(id: number): Promise<AdminUserItem> {
    const lockedExpr = sql<boolean>`coalesce(${tfUser.lockedUntil} > CURRENT_TIMESTAMP, false)`;
    const rows = await this.db
      .select(userColumns(lockedExpr))
      .from(tfUser)
      .where(eq(tfUser.userId, id));
    if (rows.length === 0) throw new NotFoundProblem('사용자를 찾을 수 없습니다');
    return (await this.withProjects(rows))[0]!;
  }

  async create(
    input: {
      loginId: string;
      userNm: string;
      email: string | null;
      isSysAdmin: boolean;
      initialPassword?: string | undefined;
    },
    a: Audit,
  ): Promise<{ user: AdminUserItem; temporaryPassword?: string }> {
    const generated = input.initialPassword === undefined;
    const password = input.initialPassword ?? generateTemporaryPassword(input.loginId);
    if (!generated) {
      const errors = passwordIssues(password, input.loginId, 'initialPassword');
      if (errors.length > 0) throw new ValidationProblem(errors);
    }
    const [dup] = await this.db
      .select({ id: tfUser.userId })
      .from(tfUser)
      .where(eq(tfUser.loginId, input.loginId));
    if (dup) throw new ConflictProblem('E_LOGIN_ID_DUP', API_ERROR_CODES.E_LOGIN_ID_DUP);
    const [row] = await insertAudited(
      this.db,
      tfUser,
      {
        loginId: input.loginId,
        userNm: input.userNm,
        email: input.email,
        passwordHash: await hashPassword(password),
        isSysAdmin: input.isSysAdmin,
        isActive: true,
        pwChangeRequired: true,
      },
      a,
    )
      .onConflictDoNothing()
      .returning({ id: tfUser.userId });
    if (!row) throw new ConflictProblem('E_LOGIN_ID_DUP', API_ERROR_CODES.E_LOGIN_ID_DUP);
    this.logger.log(
      `사용자 생성: ${input.loginId} by ${a.actor}${input.isSysAdmin ? ' (시스템 관리자)' : ''}`,
    );
    const user = await this.get(row.id);
    return generated ? { user, temporaryPassword: password } : { user };
  }

  async update(
    id: number,
    input: { userNm: string; email: string | null; isSysAdmin: boolean },
    a: Audit,
  ): Promise<AdminUserItem> {
    const target = await this.get(id);
    if (target.isSysAdmin && !input.isSysAdmin) await this.assertNotLastSysAdmin(id);
    await updateAudited(this.db, tfUser, input, a).where(eq(tfUser.userId, id));
    return this.get(id);
  }

  async setActive(
    id: number,
    isActive: boolean,
    actor: AuthUser,
    a: Audit,
  ): Promise<AdminUserItem> {
    const target = await this.get(id);
    if (!isActive) {
      if (id === actor.id)
        throw new ConflictProblem('E_SELF_DEACTIVATE', API_ERROR_CODES.E_SELF_DEACTIVATE);
      if (target.isSysAdmin) await this.assertNotLastSysAdmin(id);
    }
    await updateAudited(
      this.db,
      tfUser,
      isActive ? { isActive, loginFailCnt: 0, lockedUntil: null } : { isActive },
      a,
    ).where(eq(tfUser.userId, id));
    if (!isActive) await deleteUserSessions(this.pool, id);
    this.logger.log(`사용자 ${isActive ? '활성화' : '비활성화'}: ${target.loginId} by ${a.actor}`);
    return this.get(id);
  }

  /** 임시 비밀번호 발급(12자, 응답에 1회) + 강제 변경 + 잠금 해제 + 기존 세션 종료(§7.6). */
  async resetPassword(id: number, a: Audit): Promise<{ temporaryPassword: string }> {
    const target = await this.get(id);
    const temporaryPassword = generateTemporaryPassword(target.loginId);
    await updateAudited(
      this.db,
      tfUser,
      {
        passwordHash: await hashPassword(temporaryPassword),
        pwChangeRequired: true,
        loginFailCnt: 0,
        lockedUntil: null,
      },
      a,
    ).where(eq(tfUser.userId, id));
    await deleteUserSessions(this.pool, id);
    this.logger.log(`비밀번호 초기화: ${target.loginId} by ${a.actor}`);
    return { temporaryPassword };
  }

  /** 잠금 해제(목업 13_users [해제], CR-03 C12). */
  async unlock(id: number, a: Audit): Promise<AdminUserItem> {
    const target = await this.get(id);
    await updateAudited(this.db, tfUser, { loginFailCnt: 0, lockedUntil: null }, a).where(
      eq(tfUser.userId, id),
    );
    this.logger.log(`잠금 해제: ${target.loginId} by ${a.actor}`);
    return this.get(id);
  }

  /** 시스템 관리자 해제·비활성화 전: 나머지 활성 시스템 관리자가 1명 이상이어야 한다(§7.2). */
  private async assertNotLastSysAdmin(id: number): Promise<void> {
    const [r] = await this.db
      .select({ n: count() })
      .from(tfUser)
      .where(and(eq(tfUser.isSysAdmin, true), eq(tfUser.isActive, true), ne(tfUser.userId, id)));
    if ((r?.n ?? 0) === 0) {
      throw new ConflictProblem('E_LAST_SYS_ADMIN', API_ERROR_CODES.E_LAST_SYS_ADMIN);
    }
  }

  private async withProjects(rows: UserRow[]): Promise<AdminUserItem[]> {
    const ids = rows.map((r) => r.id);
    const members =
      ids.length === 0
        ? []
        : await this.db
            .select({
              userId: tfProjectMember.userId,
              key: tfProject.projectKey,
              nm: tfProject.projectNm,
              role: tfProjectMember.memberRole,
            })
            .from(tfProjectMember)
            .innerJoin(tfProject, eq(tfProject.projectId, tfProjectMember.projectId))
            .where(inArray(tfProjectMember.userId, ids))
            .orderBy(asc(tfProject.projectKey));
    return rows.map((r) => ({
      ...r,
      lockedUntil: iso(r.lockedUntil),
      lastLoginAt: iso(r.lastLoginAt),
      createdAt: iso(r.createdAt)!,
      projects: members
        .filter((m) => m.userId === r.id)
        .map((m) => ({ key: m.key, nm: m.nm, role: m.role as MemberRole })),
    }));
  }
}

function userColumns(lockedExpr: SQL<boolean>) {
  return {
    id: tfUser.userId,
    loginId: tfUser.loginId,
    userNm: tfUser.userNm,
    email: tfUser.email,
    isSysAdmin: tfUser.isSysAdmin,
    isActive: tfUser.isActive,
    pwChangeRequired: tfUser.pwChangeRequired,
    locked: lockedExpr,
    lockedUntil: tfUser.lockedUntil,
    lastLoginAt: tfUser.lastLoginAt,
    createdAt: tfUser.createdAt,
  };
}
type UserRow = {
  id: number;
  loginId: string;
  userNm: string;
  email: string | null;
  isSysAdmin: boolean;
  isActive: boolean;
  pwChangeRequired: boolean;
  locked: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
};

/** 비밀번호 정책 위반 → 422 errors[](§7.6, 코드 PW_*). */
export function passwordIssues(
  password: string,
  loginId: string,
  field: string,
): ValidationIssue[] {
  return checkPasswordPolicy(password, loginId).map((code) => ({
    code,
    target: 'field' as const,
    field,
    message: PASSWORD_VIOLATION_MESSAGES[code],
  }));
}
