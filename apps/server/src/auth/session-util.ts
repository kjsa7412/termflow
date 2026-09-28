import type { Request } from 'express';
import type pg from 'pg';

/** express-session 콜백 API의 Promise 래퍼. */
export function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) =>
    req.session.regenerate((e: unknown) => (e ? reject(e as Error) : resolve())),
  );
}

export function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) =>
    req.session.save((e: unknown) => (e ? reject(e as Error) : resolve())),
  );
}

export function destroySession(req: Request): Promise<void> {
  if (!req.session) return Promise.resolve();
  return new Promise((resolve) => req.session.destroy(() => resolve()));
}

/**
 * 특정 사용자의 서버 세션 삭제(비밀번호 초기화·비활성화·비밀번호 변경 시 다른 세션 무효화).
 * `tf_session.sess`(JSON)의 `user.id`로 찾는다. `exceptSid`는 남길 세션(현재 요청).
 */
export async function deleteUserSessions(
  pool: pg.Pool,
  userId: number,
  exceptSid?: string,
): Promise<number> {
  const r = await pool.query(
    `delete from tf_session where (sess -> 'user' ->> 'id')::int = $1 and ($2::text is null or sid <> $2)`,
    [userId, exceptSid ?? null],
  );
  return r.rowCount ?? 0;
}
