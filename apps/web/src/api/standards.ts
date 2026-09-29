import type {
  ApprovalBatchResponse,
  ApprovalPage,
  AuditLogItem,
  CodeClsDeleteResponse,
  CodeClsDetail,
  CodeClsItem,
  CodeItem,
  DefaultColSetItem,
  DomainCalcResult,
  DomainClsDeleteResponse,
  DomainClsItem,
  DomainClsPage,
  DomainClsSaveResponse,
  DomainDetail,
  DomainPage,
  DomainRecalcResponse,
  DomainSaveResponse,
  ImportApplyResponse,
  ImportKind,
  ImportPreview,
  Page,
  SearchResponse,
  StdType,
  TermCheckResponse,
  TermDetail,
  TermPage,
  TermSaveResponse,
  TypeSource,
} from '@termflow/shared';
import { api, type ApiClient } from './client.js';

export type Query = Record<string, string | number | boolean | undefined | null>;

export interface TermBody {
  termKor: string;
  termPhysical: string | null;
  description: string | null;
  synonymRef: string | null;
}
export interface DomainClsBody {
  suffix: string;
  clsNm: string;
  colType: StdType;
  colLength: number | null;
  colScale: number | null;
  description: string | null;
}
export interface DomainBody {
  nm1: string | null;
  nm2: string | null;
  nm3: string | null;
  nm4: string | null;
  nm5: string | null;
  nm6: string | null;
  nm7: string | null;
  typeSource: TypeSource;
  colType: StdType | null;
  colLength: number | null;
  colScale: number | null;
}
export interface CodeClsBody {
  bizAreaId: number;
  codeCls: string;
  codeClsNm: string;
  description: string | null;
}
export interface CodeBody {
  code: string;
  codeNm: string;
  sortOrder: number | null;
  isActive: boolean;
}
export interface DefaultColBody {
  defaultColId: number | null;
  logicalNm: string;
  physicalNm: string;
  isPk: boolean;
  dataType: StdType;
  dataLength: number | null;
  dataScale: number | null;
  isNullable: boolean;
  defaultVal: string | null;
  colComment: string | null;
}

const s = (key: string) => `/projects/${encodeURIComponent(key)}/standards`;

/** 표준 사전 API(§9.3·§9.4, 단계 6). */
export function standardsApi(client: ApiClient = api) {
  return {
    // 용어
    terms: (key: string, query: Query) => client.get<TermPage>(`${s(key)}/terms`, { query }),
    term: (key: string, id: number) => client.get<TermDetail>(`${s(key)}/terms/${id}`),
    checkTerm: (key: string, q: { termKor?: string; termPhysical?: string; exceptId?: number }) =>
      client.get<TermCheckResponse>(`${s(key)}/terms/check`, { query: q }),
    createTerm: (key: string, body: TermBody) =>
      client.post<TermSaveResponse>(`${s(key)}/terms`, body),
    updateTerm: (key: string, id: number, body: TermBody) =>
      client.put<TermSaveResponse>(`${s(key)}/terms/${id}`, body),
    deleteTerm: (key: string, id: number) => client.del<void>(`${s(key)}/terms/${id}`),

    // 승인 큐
    approvals: (key: string, query: Query) =>
      client.get<ApprovalPage>(`${s(key)}/approvals`, { query }),
    approvalCount: (key: string) => client.get<{ pending: number }>(`${s(key)}/approvals/count`),
    approve: (
      key: string,
      id: number,
      body: { termPhysical?: string; description?: string | null } = {},
    ) => client.post<TermSaveResponse>(`${s(key)}/approvals/${id}/approve`, body),
    reject: (key: string, id: number, note: string) =>
      client.post<TermSaveResponse>(`${s(key)}/approvals/${id}/reject`, { note }),
    approveBatch: (key: string, termIds: number[]) =>
      client.post<ApprovalBatchResponse>(`${s(key)}/approvals/approve-batch`, { termIds }),

    // 도메인분류
    domainClasses: (key: string, query: Query) =>
      client.get<DomainClsPage>(`${s(key)}/domain-classes`, { query }),
    domainCls: (key: string, id: number) =>
      client.get<DomainClsItem>(`${s(key)}/domain-classes/${id}`),
    createDomainCls: (key: string, body: DomainClsBody) =>
      client.post<DomainClsSaveResponse>(`${s(key)}/domain-classes`, body),
    updateDomainCls: (key: string, id: number, body: DomainClsBody) =>
      client.put<DomainClsSaveResponse>(`${s(key)}/domain-classes/${id}`, body),
    deleteDomainCls: (key: string, id: number, force = false) =>
      client.del<DomainClsDeleteResponse>(`${s(key)}/domain-classes/${id}`, {
        query: { force: force ? 'true' : undefined },
      }),

    // 도메인
    domains: (key: string, query: Query) => client.get<DomainPage>(`${s(key)}/domains`, { query }),
    domain: (key: string, id: number) => client.get<DomainDetail>(`${s(key)}/domains/${id}`),
    calculate: (
      key: string,
      body: DomainBody & { domainId?: number | null },
      signal?: AbortSignal,
    ) => client.post<DomainCalcResult>(`${s(key)}/domains/calculate`, body, { signal }),
    createDomain: (key: string, body: DomainBody) =>
      client.post<DomainSaveResponse>(`${s(key)}/domains`, body),
    updateDomain: (key: string, id: number, body: DomainBody) =>
      client.put<DomainSaveResponse>(`${s(key)}/domains/${id}`, body),
    deleteDomain: (key: string, id: number) =>
      client.del<{ unlinkedColumns: number }>(`${s(key)}/domains/${id}`),
    recalculate: (key: string, scope: 'REVIEW_ONLY' | 'ALL_AUTO') =>
      client.post<DomainRecalcResponse>(`${s(key)}/domains/recalculate`, { scope }),

    // 코드구분·코드
    codeClasses: (key: string, query: Query) =>
      client.get<Page<CodeClsItem>>(`${s(key)}/code-classes`, { query }),
    codeCls: (key: string, id: number, query: Query = {}) =>
      client.get<CodeClsDetail>(`${s(key)}/code-classes/${id}`, { query }),
    createCodeCls: (key: string, body: CodeClsBody) =>
      client.post<CodeClsItem>(`${s(key)}/code-classes`, body),
    updateCodeCls: (key: string, id: number, body: CodeClsBody) =>
      client.put<CodeClsItem>(`${s(key)}/code-classes/${id}`, body),
    deleteCodeCls: (key: string, id: number) =>
      client.del<CodeClsDeleteResponse>(`${s(key)}/code-classes/${id}`),
    createCode: (key: string, clsId: number, body: CodeBody) =>
      client.post<CodeItem>(`${s(key)}/code-classes/${clsId}/codes`, body),
    updateCode: (key: string, clsId: number, codeId: number, body: CodeBody) =>
      client.put<CodeItem>(`${s(key)}/code-classes/${clsId}/codes/${codeId}`, body),
    deleteCode: (key: string, clsId: number, codeId: number) =>
      client.del<void>(`${s(key)}/code-classes/${clsId}/codes/${codeId}`),

    // 기본컬럼 세트
    defaultColSets: (key: string) =>
      client.get<DefaultColSetItem[]>(`${s(key)}/default-column-sets`),
    createDefaultColSet: (key: string, body: { setNm: string; description: string | null }) =>
      client.post<DefaultColSetItem>(`${s(key)}/default-column-sets`, body),
    updateDefaultColSet: (
      key: string,
      id: number,
      body: { setNm: string; description: string | null },
    ) => client.put<DefaultColSetItem>(`${s(key)}/default-column-sets/${id}`, body),
    putDefaultCols: (key: string, id: number, columns: DefaultColBody[]) =>
      client.put<DefaultColSetItem>(`${s(key)}/default-column-sets/${id}/columns`, { columns }),
    setDefaultColSet: (key: string, id: number) =>
      client.put<DefaultColSetItem>(`${s(key)}/default-column-sets/${id}/default`),
    deleteDefaultColSet: (key: string, id: number) =>
      client.del<void>(`${s(key)}/default-column-sets/${id}`),

    // 감사·검색
    auditLogs: (key: string, query: Query) =>
      client.get<Page<AuditLogItem>>(`${s(key)}/audit-logs`, { query }),
    search: (key: string, q: string, signal?: AbortSignal) =>
      client.get<SearchResponse>(`/projects/${encodeURIComponent(key)}/search`, {
        query: { q },
        signal,
      }),

    // 일괄 등록(§9.4)
    importTemplate: (key: string, kind: ImportKind) =>
      client.download(`${s(key)}/${kind}/imports/template`),
    upload: (key: string, kind: ImportKind, file: File) => {
      const fd = new FormData();
      fd.append('file', file, file.name);
      return client.upload<ImportPreview>(`${s(key)}/${kind}/imports`, fd);
    },
    importPage: (key: string, importId: string, query: Query) =>
      client.get<ImportPreview>(`${s(key)}/imports/${importId}`, { query }),
    applyImport: (key: string, importId: string, skipErrors: boolean) =>
      client.post<ImportApplyResponse>(`${s(key)}/imports/${importId}/apply`, { skipErrors }),
    cancelImport: (key: string, importId: string) =>
      client.del<void>(`${s(key)}/imports/${importId}`),
  };
}

export type StandardsApi = ReturnType<typeof standardsApi>;
