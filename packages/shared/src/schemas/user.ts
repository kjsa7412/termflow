import { z } from 'zod';
import { PASSWORD_POLICY } from '../validation/password.js';
import { optionalText, text } from './common.js';

/** 로그인 ID: 공백 없는 1~50자(tf_user.login_id VARCHAR(50)). */
export const loginIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .regex(/^\S+$/, '공백을 포함할 수 없습니다');

const password = z.string().min(1).max(PASSWORD_POLICY.maxLength);

/** POST /auth/login(form 인코딩, §7.1). 정책 검사는 하지 않는다(기존 비밀번호 로그인). */
export const loginSchema = z.object({ loginId: loginIdSchema, password });

/** PUT /me/password — 정책(§7.6)은 서버가 checkPasswordPolicy + 직전 해시 비교로 판정. */
export const passwordChangeSchema = z.object({ currentPassword: password, newPassword: password });

/** POST /admin/users(§9.3). */
export const userCreateSchema = z.object({
  loginId: loginIdSchema,
  userNm: text(100, 1),
  email: z.email().max(100).nullable().default(null),
  isSysAdmin: z.boolean().default(false),
  /** 생략하면 서버가 12자 임시 비밀번호를 만들어 응답에 1회 돌려준다(목업 13_users, CR-03 C12). */
  initialPassword: password.optional(),
});
export type UserCreateInput = z.infer<typeof userCreateSchema>;

export const userUpdateSchema = z.object({
  userNm: text(100, 1),
  email: z.email().max(100).nullable().default(null),
  isSysAdmin: z.boolean(),
});
export const userActiveSchema = z.object({ isActive: z.boolean() });
/** 사용자 목록 상태 필터(목업 13_users 세그먼트). */
export const USER_STATUS_FILTERS = ['ALL', 'ACTIVE', 'PW_PENDING', 'LOCKED', 'INACTIVE'] as const;
export type UserStatusFilter = (typeof USER_STATUS_FILTERS)[number];
export const userSearchQuerySchema = z.object({
  q: optionalText(100).optional(),
  status: z.enum(USER_STATUS_FILTERS).default('ALL'),
  sysAdmin: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
