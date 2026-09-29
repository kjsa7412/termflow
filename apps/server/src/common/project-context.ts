import type { MemberRole, ProjectKind, ProjectStatus } from '@termflow/shared';

/**
 * 프로젝트 범위 요청 컨텍스트(설계서 §7.2, T2.8). ProjectRoleGuard(T4.4)가 경로 `:projectKey`로
 * 프로젝트·멤버십을 요청당 1회 조회해 `req.projectCtx`에 담는다. 시스템 관리자는 role=ADMIN.
 */
export interface ProjectCtx {
  projectId: number;
  projectKey: string;
  kind: ProjectKind;
  status: ProjectStatus;
  role: MemberRole;
  /** 요청자가 시스템 관리자인지(템플릿 표준 편집 허용 판정, §4.6). */
  sysAdmin: boolean;
}

declare module 'express-serve-static-core' {
  interface Request {
    projectCtx?: ProjectCtx;
  }
}
