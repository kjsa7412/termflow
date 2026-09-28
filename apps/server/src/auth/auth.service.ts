import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, sql } from 'drizzle-orm';
import { API_ERROR_CODES, type SessionUser } from '@termflow/shared';
import { audit, SYSTEM_AUDIT } from '../common/audit/audit.js';
import { LockedProblem, ProblemException } from '../common/problem/problem.exception.js';
import type { Env } from '../config/env.schema.js';
import { updateAudited } from '../db/audit.js';
import type { Db } from '../db/client.js';
import { DRIZZLE } from '../db/db.module.js';
import { tfUser } from '../db/schema.js';
import { dummyCompare, verifyPassword } from './password.js';

export interface LoginResult {
  user: SessionUser;
  mustChangePassword: boolean;
}

/** 401 로그인 실패(§7.1). 아이디 없음·비밀번호 불일치·비활성 계정을 구분하지 않는다(계정 존재 노출 방지). */
export class InvalidCredentialsProblem extends ProblemException {
  constructor() {
    super('unauthorized', 401, 'E_INVALID_CREDENTIALS', API_ERROR_CODES.E_INVALID_CREDENTIALS);
  }
}

/**
 * 로그인 검증·잠금(T4.2, §7.1·§7.6).
 *  - 잠금 중(`locked_until > now`) → 423 + 남은 분(비밀번호 검사 없이)
 *  - 비밀번호 불일치 → `login_fail_cnt + 1`, LOCKOUT_MAX(기본 5)에 닿으면 `locked_until = now + LOCKOUT_MINUTES`(15분)
 *    + 423, 카운터는 0으로 되돌린다(잠금 해제 후 다시 5회, CR-03 C13)
 *  - 성공 → 카운터·잠금 초기화, `last_login_at` 갱신
 *  - 로그인 성공·실패·잠금은 WARN 로그(비밀번호 미출력)
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');
  private readonly lockoutMax: number;
  private readonly lockoutMinutes: number;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    config: ConfigService<Env, true>,
  ) {
    this.lockoutMax = config.get('LOCKOUT_MAX', { infer: true });
    this.lockoutMinutes = config.get('LOCKOUT_MINUTES', { infer: true });
  }

  async login(loginId: string, password: string, ip: string | null): Promise<LoginResult> {
    const [u] = await this.db
      .select({
        id: tfUser.userId,
        loginId: tfUser.loginId,
        userNm: tfUser.userNm,
        hash: tfUser.passwordHash,
        isSysAdmin: tfUser.isSysAdmin,
        isActive: tfUser.isActive,
        pwChangeRequired: tfUser.pwChangeRequired,
        lockedMinutes: sql<
          number | null
        >`case when ${tfUser.lockedUntil} > CURRENT_TIMESTAMP then greatest(1, ceil(floor(extract(epoch from (${tfUser.lockedUntil} - CURRENT_TIMESTAMP))) / 60))::int end`,
        lockedUntil: tfUser.lockedUntil,
      })
      .from(tfUser)
      .where(eq(tfUser.loginId, loginId));

    if (!u) {
      await dummyCompare(password);
      this.logger.warn(`로그인 실패: ${loginId} (계정 없음) ip=${ip ?? '-'}`);
      throw new InvalidCredentialsProblem();
    }
    if (u.lockedMinutes !== null) {
      this.logger.warn(
        `로그인 거부(잠금 중): ${loginId} 남은 ${u.lockedMinutes}분 ip=${ip ?? '-'}`,
      );
      throw this.locked(u.lockedMinutes, u.lockedUntil);
    }
    if (!u.isActive) {
      await dummyCompare(password);
      this.logger.warn(`로그인 실패: ${loginId} (비활성) ip=${ip ?? '-'}`);
      throw new InvalidCredentialsProblem();
    }
    if (!(await verifyPassword(password, u.hash))) {
      const [after] = await updateAudited(
        this.db,
        tfUser,
        {
          loginFailCnt: sql`case when ${tfUser.loginFailCnt} + 1 >= ${this.lockoutMax} then 0 else ${tfUser.loginFailCnt} + 1 end`,
          lockedUntil: sql`case when ${tfUser.loginFailCnt} + 1 >= ${this.lockoutMax}
            then CURRENT_TIMESTAMP + make_interval(mins => ${this.lockoutMinutes}) else ${tfUser.lockedUntil} end`,
        },
        audit(SYSTEM_AUDIT.actor, ip),
      )
        .where(eq(tfUser.userId, u.id))
        .returning({ failCnt: tfUser.loginFailCnt, lockedUntil: tfUser.lockedUntil });
      if (after && after.failCnt === 0 && after.lockedUntil) {
        this.logger.warn(
          `계정 잠금: ${loginId} ${this.lockoutMax}회 연속 실패, ${this.lockoutMinutes}분 ip=${ip ?? '-'}`,
        );
        throw this.locked(this.lockoutMinutes, after.lockedUntil);
      }
      this.logger.warn(
        `로그인 실패: ${loginId} (${after?.failCnt ?? '?'}/${this.lockoutMax}) ip=${ip ?? '-'}`,
      );
      throw new InvalidCredentialsProblem();
    }
    await updateAudited(
      this.db,
      tfUser,
      { loginFailCnt: 0, lockedUntil: null, lastLoginAt: sql`CURRENT_TIMESTAMP` },
      audit(u.loginId, ip),
    ).where(eq(tfUser.userId, u.id));
    this.logger.warn(`로그인 성공: ${loginId} ip=${ip ?? '-'}`);
    return {
      user: { id: u.id, loginId: u.loginId, userNm: u.userNm, isSysAdmin: u.isSysAdmin },
      mustChangePassword: u.pwChangeRequired,
    };
  }

  private locked(minutes: number, until: string | null): LockedProblem {
    return new LockedProblem(
      `계정이 잠겼습니다. ${minutes}분 후 다시 시도하거나 관리자에게 해제를 요청하세요`,
      {
        remainingMinutes: minutes,
        lockedUntil: until ? until.replace(' ', 'T') : null,
      },
    );
  }
}
