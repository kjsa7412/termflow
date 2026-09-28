import { z } from 'zod';
import { MEMBER_ROLES } from '../enums.js';
import { idSchema } from './common.js';

/** 프로젝트 멤버(§7.2, §9.3 P/members). */
export const memberInputSchema = z.object({ userId: idSchema, role: z.enum(MEMBER_ROLES) });
export type MemberInput = z.infer<typeof memberInputSchema>;
export const memberRoleSchema = z.object({ role: z.enum(MEMBER_ROLES) });
