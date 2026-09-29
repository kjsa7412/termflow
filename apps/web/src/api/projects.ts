import type {
  AdminProjectItem,
  BizAreaDeletePreview,
  BizAreaDeleteResponse,
  BizAreaItem,
  CopyLogItem,
  CopyPreviewResponse,
  CopySourceKind,
  CopySourcesResponse,
  Dialect,
  MemberCandidate,
  MemberItem,
  MemberRole,
  ProjectCard,
  ProjectCreateResponse,
  ProjectHome,
  ProjectSettings,
  ProjectStatus,
  TemplateItem,
} from '@termflow/shared';
import { api, type ApiClient } from './client.js';

/** 항목 원본(§9.5 imports의 한 항목). EMPTY가 아니면 sourceKey 필수. */
export interface ImportSource {
  source: CopySourceKind;
  sourceKey?: string;
}
/** 마법사 imports 요청 본문(§9.5). */
export interface ImportsInput {
  bizAreas: ImportSource & { bizCds?: string[] };
  terms: ImportSource & { approvedOnly?: boolean };
  domainClasses: ImportSource;
  domains: ImportSource;
  codes: ImportSource;
  defaultColSets: ImportSource;
}

export interface ProjectCreateBody {
  projectKey: string;
  projectNm: string;
  description: string | null;
  defaultDialect: Dialect;
  imports: ImportsInput;
  members: { userId: number; role: MemberRole }[];
}

export interface BizAreaBody {
  bizCd: string;
  bizNm: string;
  tablePrefix?: string | null;
  sortNo: number;
  useYn: boolean;
  description: string | null;
}

export interface SettingsBody {
  projectNm: string;
  description: string | null;
  defaultDialect: Dialect;
  includeDefaultCols: boolean;
  defaultColSetId: number | null;
}

const p = (key: string) => `/projects/${encodeURIComponent(key)}`;

/** 프로젝트·멤버·업무구분·시스템(프로젝트·템플릿) API(§9.3, 단계 5). */
export function projectsApi(client: ApiClient = api) {
  return {
    list: (q: { q?: string; includeArchived?: boolean; mine?: boolean } = {}) =>
      client.get<ProjectCard[]>('/projects', {
        query: {
          q: q.q,
          includeArchived: q.includeArchived ? 'true' : undefined,
          mine: q.mine ? 'true' : undefined,
        },
      }),
    checkKey: (key: string) =>
      client.get<{ available: boolean; reason?: string }>('/projects/check-key', {
        query: { key },
      }),
    copySources: () => client.get<CopySourcesResponse>('/projects/copy-sources'),
    preview: (imports: ImportsInput) =>
      client.post<CopyPreviewResponse>('/projects/copy-preview', { imports }),
    create: (body: ProjectCreateBody) => client.post<ProjectCreateResponse>('/projects', body),
    home: (key: string) => client.get<ProjectHome>(p(key)),
    settings: (key: string) => client.get<ProjectSettings>(`${p(key)}/settings`),
    updateSettings: (key: string, body: SettingsBody) =>
      client.put<ProjectSettings>(`${p(key)}/settings`, body),
    copyLog: (key: string) => client.get<CopyLogItem[]>(`${p(key)}/copy-log`),

    members: (key: string) => client.get<MemberItem[]>(`${p(key)}/members`),
    memberCandidates: (key: string, q: string) =>
      client.get<MemberCandidate[]>(`${p(key)}/member-candidates`, { query: { q } }),
    addMember: (key: string, userId: number, role: MemberRole) =>
      client.post<MemberItem>(`${p(key)}/members`, { userId, role }),
    updateMember: (key: string, userId: number, role: MemberRole) =>
      client.put<MemberItem>(`${p(key)}/members/${userId}`, { role }),
    removeMember: (key: string, userId: number) => client.del<void>(`${p(key)}/members/${userId}`),

    bizAreas: (key: string) => client.get<BizAreaItem[]>(`${p(key)}/biz-areas`),
    createBizArea: (key: string, body: BizAreaBody) =>
      client.post<BizAreaItem>(`${p(key)}/biz-areas`, body),
    updateBizArea: (key: string, id: number, body: BizAreaBody) =>
      client.put<BizAreaItem>(`${p(key)}/biz-areas/${id}`, body),
    bizAreaDeletePreview: (key: string, id: number) =>
      client.get<BizAreaDeletePreview>(`${p(key)}/biz-areas/${id}/delete-preview`),
    deleteBizArea: (key: string, id: number) =>
      client.del<BizAreaDeleteResponse>(`${p(key)}/biz-areas/${id}`),

    adminProjects: (q: { q?: string; status?: ProjectStatus } = {}) =>
      client.get<AdminProjectItem[]>('/admin/projects', { query: q }),
    setProjectStatus: (key: string, status: ProjectStatus) =>
      client.put<AdminProjectItem>(`/admin/projects/${encodeURIComponent(key)}/status`, { status }),
    deleteProject: (key: string, confirmKey: string) =>
      client.del<void>(`/admin/projects/${encodeURIComponent(key)}`, { body: { confirmKey } }),

    templates: () => client.get<TemplateItem[]>('/admin/templates'),
    publishTemplate: (body: {
      sourceProjectKey: string;
      projectKey: string;
      projectNm: string;
      description: string | null;
      approvedOnly: boolean;
    }) => client.post<ProjectCreateResponse>('/admin/templates', body),
    setTemplateStatus: (key: string, status: ProjectStatus) =>
      client.put<TemplateItem>(`/admin/templates/${encodeURIComponent(key)}/status`, { status }),
    deleteTemplate: (key: string, confirmKey: string) =>
      client.del<void>(`/admin/templates/${encodeURIComponent(key)}`, { body: { confirmKey } }),
  };
}

export type ProjectsApi = ReturnType<typeof projectsApi>;
