import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import type { ApiTokenCreateInput, ApiTokenItem } from '@termflow/shared';
import type { Audit } from '../common/audit/audit.js';
import { NotFoundProblem } from '../common/problem/problem.exception.js';
import { insertAudited, updateAudited } from '../db/audit.js';
import type { Db } from '../db/client.js';
import { DRIZZLE } from '../db/db.module.js';
import { tfApiToken, tfUser } from '../db/schema.js';

/** 토큰 원문 머리말. 원문 = `tfp_` + 32바이트 base64url(43자). */
export const TOKEN_PREFIX = 'tfp_';
const TOKEN_RE = /^tfp_[A-Za-z0-9_-]{43}$/;
/** 화면 식별용으로 남기는 원문 앞부분 길이(`tfp_` + 8자). */
const SHOWN = TOKEN_PREFIX.length + 8;
/** 마지막 사용 시각은 1분에 한 번만 기록한다(요청마다 UPDATE 하지 않게). */
const TOUCH_INTERVAL = sql`interval '1 minute'`;

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** Bearer로 인증된 요청의 토큰 주체(`req.tokenAuth`). 권한 값은 SessionAuthGuard가 tf_user에서 다시 읽는다. */
export interface TokenAuth {
  tokenId: number;
  userId: number;
  loginId: string;
  tokenPrefix: string;
}

const itemColumns = {
  tokenId: tfApiToken.tokenId,
  tokenNm: tfApiToken.tokenNm,
  tokenPrefix: tfApiToken.tokenPrefix,
  createdAt: tfApiToken.createdAt,
  expiresAt: tfApiToken.expiresAt,
  lastUsedAt: tfApiToken.lastUsedAt,
  lastUsedIp: tfApiToken.lastUsedIp,
  revokedAt: tfApiToken.revokedAt,
  expired: sql<boolean>`${tfApiToken.expiresAt} <= CURRENT_TIMESTAMP`,
};

type ItemRow = {
  tokenId: number;
  tokenNm: string;
  tokenPrefix: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
  expired: boolean;
};

function toItem(r: ItemRow): ApiTokenItem {
  return {
    tokenId: r.tokenId,
    tokenNm: r.tokenNm,
    tokenPrefix: r.tokenPrefix,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    lastUsedAt: r.lastUsedAt,
    lastUsedIp: r.lastUsedIp,
    status: r.revokedAt ? 'REVOKED' : r.expired ? 'EXPIRED' : 'ACTIVE',
  };
}

/**
 * 개인 접근 토큰(CR-18 C3). 원문은 발급 응답에서 한 번만 돌려주고 DB에는 SHA-256만 둔다.
 * 토큰은 발급한 사용자의 권한을 그대로 갖는다(프로젝트 역할·시스템 관리자 — 요청마다 다시 판정).
 */
@Injectable()
export class ApiTokenService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(userId: number): Promise<ApiTokenItem[]> {
    const rows = await this.db
      .select(itemColumns)
      .from(tfApiToken)
      .where(eq(tfApiToken.userId, userId))
      .orderBy(desc(tfApiToken.tokenId));
    return rows.map(toItem);
  }

  async issue(
    userId: number,
    input: ApiTokenCreateInput,
    a: Audit,
  ): Promise<{ item: ApiTokenItem; token: string }> {
    const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
    // 만료 시각은 DB 시계(세션 timezone Asia/Seoul) 기준 문자열 — timestamp mode 'string'과 같은 형식.
    const expiry = await this.db.execute<{ at: string }>(
      sql`select to_char(CURRENT_TIMESTAMP + make_interval(days => ${input.expiresInDays}), 'YYYY-MM-DD HH24:MI:SS') as at`,
    );
    const [row] = await insertAudited(
      this.db,
      tfApiToken,
      {
        userId,
        tokenNm: input.tokenNm,
        tokenPrefix: token.slice(0, SHOWN),
        tokenHash: hashToken(token),
        expiresAt: expiry.rows[0]!.at,
      },
      a,
    ).returning({ tokenId: tfApiToken.tokenId });
    const [item] = await this.db
      .select(itemColumns)
      .from(tfApiToken)
      .where(eq(tfApiToken.tokenId, row!.tokenId));
    return { item: toItem(item!), token };
  }

  /** 본인 토큰 폐기. 남의 토큰·없는 ID는 404. 이미 폐기된 토큰은 그대로 둔다. */
  async revoke(userId: number, tokenId: number, a: Audit): Promise<void> {
    const rows = await updateAudited(this.db, tfApiToken, { revokedAt: sql`CURRENT_TIMESTAMP` }, a)
      .where(and(eq(tfApiToken.tokenId, tokenId), eq(tfApiToken.userId, userId)))
      .returning({ tokenId: tfApiToken.tokenId });
    if (rows.length === 0) throw new NotFoundProblem('접근 토큰을 찾을 수 없습니다');
  }

  /** 사용자의 유효 토큰 전부 폐기(비밀번호 초기화·비활성화). 폐기 건수. */
  async revokeAll(userId: number, a: Audit): Promise<number> {
    const rows = await updateAudited(this.db, tfApiToken, { revokedAt: sql`CURRENT_TIMESTAMP` }, a)
      .where(and(eq(tfApiToken.userId, userId), isNull(tfApiToken.revokedAt)))
      .returning({ tokenId: tfApiToken.tokenId });
    return rows.length;
  }

  /** Bearer 원문 확인: 형식 → 해시 → 폐기·만료·사용자 활성. 통과하면 마지막 사용 시각·IP를 남긴다(1분 간격). */
  async verify(raw: string, ip: string | null): Promise<TokenAuth | null> {
    if (!TOKEN_RE.test(raw)) return null;
    const [row] = await this.db
      .select({
        tokenId: tfApiToken.tokenId,
        userId: tfApiToken.userId,
        tokenPrefix: tfApiToken.tokenPrefix,
        loginId: tfUser.loginId,
      })
      .from(tfApiToken)
      .innerJoin(tfUser, eq(tfUser.userId, tfApiToken.userId))
      .where(
        and(
          eq(tfApiToken.tokenHash, hashToken(raw)),
          isNull(tfApiToken.revokedAt),
          gt(tfApiToken.expiresAt, sql`CURRENT_TIMESTAMP`),
          eq(tfUser.isActive, true),
        ),
      );
    if (!row) return null;
    // 감사 컬럼(updated_*)은 사용 기록으로 바꾸지 않는다 — 발급·폐기 주체만 남긴다.
    await this.db
      .update(tfApiToken)
      .set({ lastUsedAt: sql`CURRENT_TIMESTAMP`, lastUsedIp: ip })
      .where(
        and(
          eq(tfApiToken.tokenId, row.tokenId),
          or(
            isNull(tfApiToken.lastUsedAt),
            lt(tfApiToken.lastUsedAt, sql`CURRENT_TIMESTAMP - ${TOUCH_INTERVAL}`),
          ),
        ),
      );
    return row;
  }
}
