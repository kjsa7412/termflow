import type {
  ColumnInput,
  DdlExtractResponse,
  DdlOptionsInput,
  DdlResponse,
  Dialect,
  ExportLogItem,
  Page,
  TableCloneResponse,
  TableDetail,
  TableHistoryDetail,
  TableHistoryItem,
  TablePage,
  TableSaveResponse,
  TableStatus,
  TableStatusResponse,
  TableValidateResponse,
} from '@termflow/shared';
import { api, type ApiClient } from './client.js';
import type { Query } from './standards.js';

const p = (key: string) => `/projects/${encodeURIComponent(key)}`;

/** DDL 요청 선택(§6.10): 테이블 ID(사용자 순서) 또는 업무구분 ID. */
export interface DdlSelection {
  tableIds?: number[];
  bizAreaIds?: number[];
  dialect?: Dialect;
  options?: DdlOptionsInput;
  /** 편집기 미리보기(§10.4): 저장 전 본문. 주면 tableIds·bizAreaIds 대신 이 본문으로 생성한다. */
  draft?: TableCreateBody;
}

/** 테이블 목록·DDL·정보 추출·내보내기 기록 API(§9.3, 단계 7). 생성은 서버가 한다(P4) — 화면은 결과를 표시만. */
export function tablesApi(client: ApiClient = api) {
  return {
    tables: (key: string, query: Query, signal?: AbortSignal) =>
      client.get<TablePage>(`${p(key)}/tables`, { query, signal }),
    /** 미리보기(JSON, 기록 없음). */
    ddl: (key: string, body: DdlSelection, signal?: AbortSignal) =>
      client.post<DdlResponse>(`${p(key)}/ddl`, { ...body, output: 'JSON' }, { signal }),
    /** 다운로드: SQL(단일 .sql, DOWNLOAD 기록) / ZIP(테이블별, ZIP 기록). */
    ddlFile: (key: string, body: DdlSelection, output: 'SQL' | 'ZIP') =>
      client.downloadPost(`${p(key)}/ddl`, { ...body, output }),
    extract: (key: string, body: DdlSelection, signal?: AbortSignal) =>
      client.post<DdlExtractResponse>(
        `${p(key)}/ddl/extract`,
        { ...body, output: 'JSON' },
        { signal },
      ),
    extractFile: (key: string, body: DdlSelection) =>
      client.downloadPost(`${p(key)}/ddl/extract`, { ...body, output: 'TSV' }),
    /** 화면 복사 기록(COPY: DDL, EXTRACT: 탭 구분 텍스트). */
    recordCopy: (
      key: string,
      body: {
        kind: 'COPY' | 'EXTRACT';
        tableIds: number[];
        dialect?: Dialect;
        options?: DdlOptionsInput;
        warningCnt?: number;
      },
    ) => client.post<{ exportId: number }>(`${p(key)}/export-logs`, body),
    exportLogs: (key: string, query: Query = {}) =>
      client.get<Page<ExportLogItem>>(`${p(key)}/export-logs`, { query }),

    // ── 테이블 설계 편집(단계 8, §9.3) ──────────────────────────────
    detail: (key: string, id: number) => client.get<TableDetail>(`${p(key)}/tables/${id}`),
    create: (key: string, body: TableCreateBody) =>
      client.post<TableSaveResponse>(`${p(key)}/tables`, body),
    save: (key: string, id: number, body: TableCreateBody & { version: number }) =>
      client.put<TableSaveResponse>(`${p(key)}/tables/${id}`, body),
    validate: (
      key: string,
      body: TableCreateBody & { tableId?: number },
      signal?: AbortSignal,
    ) => client.post<TableValidateResponse>(`${p(key)}/tables/validate`, body, { signal }),
    remove: (key: string, id: number) => client.del<void>(`${p(key)}/tables/${id}`),
    setStatus: (
      key: string,
      id: number,
      body: { status: TableStatus; version: number; note?: string | null },
    ) => client.put<TableStatusResponse>(`${p(key)}/tables/${id}/status`, body),
    clone: (
      key: string,
      id: number,
      body: { targetProjectKey?: string; targetBizAreaId?: number; tableNm?: string } = {},
    ) => client.post<TableCloneResponse>(`${p(key)}/tables/${id}/clone`, body),
    history: (key: string, id: number) =>
      client.get<TableHistoryItem[]>(`${p(key)}/tables/${id}/history`),
    historyVersion: (key: string, id: number, version: number) =>
      client.get<TableHistoryDetail>(`${p(key)}/tables/${id}/history/${version}`),
    restore: (key: string, id: number, version: number, currentVersion: number) =>
      client.post<TableSaveResponse>(`${p(key)}/tables/${id}/history/${version}/restore`, {
        version: currentVersion,
      }),
  };
}

/** 저장 본문(§9.5) — `TableCreateInput`의 입력형(기본값 적용 전). */
export interface TableCreateBody {
  table: {
    bizAreaId: number | null;
    tableNm: string;
    tableLogicalNm: string;
    description: string | null;
  };
  columns: ColumnInput[];
}
export type TablesApi = ReturnType<typeof tablesApi>;
