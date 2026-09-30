import type {
  AutocompleteBatchResponse,
  AutocompleteResponse,
  TableNameSuggestion,
  TermInlineResponse,
} from '@termflow/shared';
import { api, type ApiClient } from './client.js';

const p = (key: string) => `/projects/${encodeURIComponent(key)}`;

/** 자동완성·물리명 제안·인라인 용어 등록(설계서 §5.4·§5.5·§5.9, 단계 9). */
export function autocompleteApi(client: ApiClient = api) {
  return {
    column: (
      key: string,
      body: { logicalNm: string; excludeColumnId?: number | null; bizAreaId?: number | null },
      signal?: AbortSignal,
    ) => client.post<AutocompleteResponse>(`${p(key)}/autocomplete/columns`, body, { signal }),
    batch: (key: string, body: { logicalNms: string[]; bizAreaId?: number | null }) =>
      client.post<AutocompleteBatchResponse>(`${p(key)}/autocomplete/columns/batch`, body),
    suggestName: (
      key: string,
      body: { logicalNm: string; bizAreaId: number | null; tableId?: number },
      signal?: AbortSignal,
    ) => client.post<TableNameSuggestion>(`${p(key)}/tables/suggest-name`, body, { signal }),
    inlineTerm: (
      key: string,
      body: { termKor: string; termPhysical: string; description?: string | null },
    ) => client.post<TermInlineResponse>(`${p(key)}/standards/terms/inline`, body),
  };
}
export type AutocompleteApi = ReturnType<typeof autocompleteApi>;
