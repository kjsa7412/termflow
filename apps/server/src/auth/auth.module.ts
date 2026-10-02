import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import type pg from 'pg';
import type session from 'express-session';
import type { Env } from '../config/env.schema.js';
import { PG_POOL } from '../db/db.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { BootstrapAdmin } from './bootstrap-admin.js';
import { PasswordChangeGuard } from './guards/password-change.guard.js';
import { ProjectRoleGuard } from './guards/project-role.guard.js';
import { SessionAuthGuard } from './guards/session-auth.guard.js';
import { SysAdminGuard } from './guards/sys-admin.guard.js';
import {
  cookieEnvOf,
  cookieNames,
  COOKIE_NAMES,
  createCsrf,
  createSessionStore,
  CSRF_UTILS,
  SESSION_STORE,
} from './http-security.js';

/**
 * 인증 모듈(T4.1~T4.4). 전역 가드 순서: SessionAuthGuard(인증) → PasswordChangeGuard(강제 변경).
 * SysAdminGuard·ProjectRoleGuard는 데코레이터(`@SysAdmin()`, `@ProjectRole()`)로 붙는다.
 * 세션 저장소·CSRF 유틸은 main.ts의 applyHttpSecurity가 같은 인스턴스를 미들웨어로 건다.
 */
@Global()
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    BootstrapAdmin,
    SysAdminGuard,
    ProjectRoleGuard,
    { provide: APP_GUARD, useClass: SessionAuthGuard },
    { provide: APP_GUARD, useClass: PasswordChangeGuard },
    {
      provide: CSRF_UTILS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        createCsrf({
          NODE_ENV: config.get('NODE_ENV', { infer: true }),
          TERMFLOW_SESSION_SECRET: config.get('TERMFLOW_SESSION_SECRET', { infer: true }),
          TERMFLOW_SESSION_TIMEOUT: config.get('TERMFLOW_SESSION_TIMEOUT', { infer: true }),
          TERMFLOW_SECURE_COOKIE: config.get('TERMFLOW_SECURE_COOKIE', { infer: true }),
          ...cookieEnvOf(config),
        }),
    },
    {
      provide: COOKIE_NAMES,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => cookieNames(cookieEnvOf(config)),
    },
    {
      provide: SESSION_STORE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool) => createSessionStore(pool),
    },
  ],
  exports: [AuthService, CSRF_UTILS, SESSION_STORE, SysAdminGuard, ProjectRoleGuard],
})
export class AuthModule implements OnApplicationShutdown {
  constructor(@Inject(SESSION_STORE) private readonly store: session.Store & { close(): void }) {}

  /** connect-pg-simple 정리 타이머 해제(PoC T1.5 ⑤) — 풀 종료(DbModule)보다 먼저. */
  onApplicationShutdown(): void {
    this.store.close();
  }
}
