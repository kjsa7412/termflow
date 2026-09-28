import { Injectable } from '@nestjs/common';
import { ClsService, type ClsModuleOptions } from 'nestjs-cls';
import type { Request } from 'express';
import { UnauthorizedProblem } from '../problem/problem.exception.js';
import { audit, clientIp, type Audit } from './audit.js';

const ACTOR = 'audit.actor';
const IP = 'audit.ip';

/** 세션에 담는 로그인 사용자(§2.5.4: session.user). 인증 구현은 T4.1. */
export interface SessionUserLike {
  loginId: string;
}

/**
 * nestjs-cls 설정: 요청마다 CLS에 로그인 ID와 클라이언트 IP를 담는다(§8.6).
 * express-session 미들웨어(app.use)가 먼저 실행되므로 여기서 req.session을 읽을 수 있다.
 */
export const clsOptions: ClsModuleOptions = {
  global: true,
  middleware: {
    mount: true,
    setup: (cls, req: Request) => {
      const session = (req as Request & { session?: { user?: SessionUserLike } }).session;
      cls.set(ACTOR, session?.user?.loginId ?? null);
      cls.set(IP, clientIp(req));
    },
  },
};

/** 요청 스코프 감사 컨텍스트 → `Audit{actor, ip}`(§8.6 N안). */
@Injectable()
export class AuditContext {
  constructor(private readonly cls: ClsService) {}

  /** 로그인 사용자 기준 Audit. 미인증 요청이면 401. */
  current(): Audit {
    const actor = this.cls.isActive() ? (this.cls.get<string | null>(ACTOR) ?? null) : null;
    if (!actor) throw new UnauthorizedProblem();
    return audit(actor, this.ip());
  }

  /** 주체만 다른 Audit(예: 로그인 성공 시 사용자 레코드 갱신). IP는 요청 값. */
  as(actor: string): Audit {
    return audit(actor, this.ip());
  }

  ip(): string | null {
    return this.cls.isActive() ? (this.cls.get<string | null>(IP) ?? null) : null;
  }
}
