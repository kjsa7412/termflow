import type { SessionUser } from '@termflow/shared';

/**
 * 세션에 담는 로그인 사용자(설계서 §2.5.4 `session.user`). 권한 판정에 쓰는 값(시스템 관리자·강제 변경·활성)은
 * 세션 스냅샷을 믿지 않고 SessionAuthGuard가 요청마다 tf_user에서 다시 읽어 `req.authUser`에 둔다
 * (관리자가 권한을 바꾸거나 비활성화하면 다음 요청부터 반영).
 */
export type SessionUserData = SessionUser;

/** 요청 단위 인증 사용자(DB 최신 값). */
export interface AuthUser extends SessionUser {
  mustChangePassword: boolean;
}

declare module 'express-session' {
  interface SessionData {
    user?: SessionUserData;
    /** 익명 세션 표식: csrf 토큰 바인딩용 저장 트리거(PoC T1.5, CR-02 C7). */
    anon?: boolean;
  }
}

declare module 'express-serve-static-core' {
  interface Request {
    authUser?: AuthUser;
  }
}
