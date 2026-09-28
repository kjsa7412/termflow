import type {
  AdminUserCreateResponse,
  AdminUserItem,
  AdminUserPage,
  PasswordResetResponse,
  UserStatusFilter,
} from '@termflow/shared';
import { api, type ApiClient } from './client.js';

export interface UserListParams {
  q?: string;
  status?: UserStatusFilter;
  sysAdmin?: boolean;
  page?: number;
  size?: number;
}

/** 사용자 관리 API(`/admin/users/**`, 시스템 관리자). */
export function usersApi(client: ApiClient = api) {
  return {
    list: (p: UserListParams = {}) =>
      client.get<AdminUserPage>('/admin/users', {
        query: {
          q: p.q,
          status: p.status && p.status !== 'ALL' ? p.status : undefined,
          sysAdmin: p.sysAdmin ? 'true' : undefined,
          page: p.page,
          size: p.size,
        },
      }),
    create: (body: {
      loginId: string;
      userNm: string;
      email: string | null;
      isSysAdmin: boolean;
    }) => client.post<AdminUserCreateResponse>('/admin/users', body),
    update: (id: number, body: { userNm: string; email: string | null; isSysAdmin: boolean }) =>
      client.put<AdminUserItem>(`/admin/users/${id}`, body),
    setActive: (id: number, isActive: boolean) =>
      client.put<AdminUserItem>(`/admin/users/${id}/active`, { isActive }),
    resetPassword: (id: number) =>
      client.post<PasswordResetResponse>(`/admin/users/${id}/reset-password`),
    unlock: (id: number) => client.post<AdminUserItem>(`/admin/users/${id}/unlock`),
  };
}
