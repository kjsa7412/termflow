import type {
  ApiTokenCreateResponse,
  ApiTokenListResponse,
  LoginResponse,
  MeResponse,
} from '@termflow/shared';
import { api, type ApiClient } from './client.js';

/** 인증·내 계정 API(§9.3). */
export function authApi(client: ApiClient = api) {
  return {
    async login(loginId: string, password: string): Promise<LoginResponse> {
      const res = await client.request<LoginResponse>('POST', '/auth/login', {
        form: { loginId, password },
      });
      client.setCsrfToken(res.csrfToken);
      return res;
    },
    async logout(): Promise<void> {
      try {
        await client.post<void>('/auth/logout');
      } finally {
        client.setCsrfToken(null);
      }
    },
    me: () => client.get<MeResponse>('/me'),
    changePassword: (currentPassword: string, newPassword: string) =>
      client.put<void>('/me/password', { currentPassword, newPassword }),
    /** 개인 접근 토큰(CR-18). */
    tokens: () => client.get<ApiTokenListResponse>('/me/tokens'),
    issueToken: (tokenNm: string, expiresInDays: number) =>
      client.post<ApiTokenCreateResponse>('/me/tokens', { tokenNm, expiresInDays }),
    revokeToken: (tokenId: number) => client.del<void>(`/me/tokens/${tokenId}`),
  };
}
