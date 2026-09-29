import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import type { MemberRole } from '@termflow/shared';
import { ProjectRoleGuard } from './guards/project-role.guard.js';
import { SysAdminGuard } from './guards/sys-admin.guard.js';

export const IS_PUBLIC = 'tf:isPublic';
export const ALLOW_PW_CHANGE = 'tf:allowDuringPasswordChange';
export const PROJECT_ROLE = 'tf:projectRole';
export const PROJECT_READ_ONLY_POST = 'tf:projectReadOnlyPost';

/** 익명 허용(§7.3: `/auth/login`, `/auth/csrf`, `/health`). 전역 SessionAuthGuard를 건너뛴다. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** 강제 비밀번호 변경 중에도 허용(§7.3: `/me/password`·`/auth/*`·`/me`). */
export const AllowDuringPasswordChange = () => SetMetadata(ALLOW_PW_CHANGE, true);

/** 시스템 관리자 전용(`tf_user.is_sys_admin`, §7.2). */
export const SysAdmin = () => UseGuards(SysAdminGuard);

/**
 * 프로젝트 역할 이상(`VIEWER < EDITOR < ADMIN`, §7.2). 경로 `:projectKey`로 프로젝트·멤버십을 조회해
 * `req.projectCtx`를 채운다. 비멤버·템플릿(시스템 관리자 외)은 404, 보관·템플릿 쓰기는 409 `E_PROJECT_READONLY`.
 * `readOnly: true`: 본문이 필요한 **조회성 POST**(DDL 생성·정보 추출·내보내기 기록, §6.10)는 보관 프로젝트에서도 허용한다.
 */
export const ProjectRole = (role: MemberRole, opts: { readOnly?: boolean } = {}) =>
  applyDecorators(
    SetMetadata(PROJECT_ROLE, role),
    SetMetadata(PROJECT_READ_ONLY_POST, opts.readOnly === true),
    UseGuards(ProjectRoleGuard),
  );
