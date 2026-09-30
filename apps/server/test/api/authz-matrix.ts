/**
 * 권한 매트릭스(설계서 §7.3)를 데이터로 둔다(T4.7). `test/db/authz-matrix.test.ts`가 역할 6종 × 행을 자동 생성한다.
 * 단계 4는 인증·내 계정·사용자 행, 단계 5는 프로젝트·멤버·업무구분·시스템(프로젝트·템플릿) 행을 채운다.
 * `P` = `/projects/PRJA`(std_small: pa=ADMIN, editor=EDITOR, viewer=VIEWER, nobody=비멤버 → 404).
 *
 * - `allow`: 허용 역할. 허용이면 `ok` 상태 중 하나(업무 규칙 409·422도 "핸들러 도달" = 허용 증명), 거부면 익명 401 ·
 *   그 외 `denyByRole[role]` → `deny`(기본 403). 프로젝트 행은 비멤버(login) 404.
 * - `run`: 요청 1건(요청에 필요한 ID는 ctx에서). 비-GET은 클라이언트가 CSRF 헤더를 자동으로 붙인다.
 */
export const ROLES = ['anon', 'login', 'viewer', 'editor', 'pa', 'sa'] as const;
export type Role = (typeof ROLES)[number];

/** 역할별 로그인 계정(std_small 픽스처 + 무소속 사용자 `nobody`). anon은 로그인하지 않는다. */
export const ROLE_LOGIN: Record<Exclude<Role, 'anon'>, string> = {
  login: 'nobody',
  viewer: 'viewer',
  editor: 'editor',
  pa: 'pa',
  sa: 'sysadmin',
};

export interface MatrixClient {
  get(path: string): Promise<{ status: number; body: unknown }>;
  post(
    path: string,
    body?: object,
    opts?: { form?: boolean },
  ): Promise<{ status: number; body: unknown }>;
  put(path: string, body?: object): Promise<{ status: number; body: unknown }>;
  delete(path: string, body?: object): Promise<{ status: number; body: unknown }>;
}

export interface MatrixCtx {
  /** 사용자 관리 대상(픽스처 밖 전용 사용자) ID. */
  targetUserId: number;
  /** 케이스마다 다른 값(생성 요청의 loginId 등). */
  seq: () => number;
  fixturePassword: string;
  /** PRJA 업무구분(RP: 테이블 1 → 잠김, PS: 테이블 0). */
  bizRpId: number;
  bizPsId: number;
  /** PRJA 프로젝트 관리자(유일한 ADMIN) user_id — 제거 시도는 409 E_LAST_PROJECT_ADMIN. */
  paUserId: number;
  /** PRJA 표준 사전 ID(단계 6 행): 승인 용어·검토대기 2건·도메인·도메인분류·코드구분·기본컬럼 세트. */
  /** PRJA 테이블(RP_RSCH_PRJ_MST, DRAFT, 이력 v1) — 단계 7 DDL 행·단계 8 테이블 행. */
  tableId: number;
  /** PRJA FINAL 테이블(단계 8: 확정 해제·FINAL 삭제 = 프로젝트 관리자). */
  finalTableId: number;
  std: {
    termId: number;
    pendingApproveId: number;
    pendingRejectId: number;
    domainId: number;
    domainClsId: number;
    codeClsId: number;
    setId: number;
  };
}

export interface MatrixRow {
  /** §7.3 경로 표기(보고용). */
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  allow: readonly Role[];
  ok: readonly number[];
  deny?: number;
  denyByRole?: Partial<Record<Role, number>>;
  run: (c: MatrixClient, ctx: MatrixCtx) => Promise<{ status: number; body: unknown }>;
}

const ALL: readonly Role[] = ROLES;
const LOGGED_IN: readonly Role[] = ['login', 'viewer', 'editor', 'pa', 'sa'];
const SA: readonly Role[] = ['sa'];
const VIEWER_UP: readonly Role[] = ['viewer', 'editor', 'pa', 'sa'];
const PA_UP: readonly Role[] = ['pa', 'sa'];
/** 프로젝트 행: 비멤버(login)는 403이 아니라 404(§7.3 존재 노출 방지). */
const P_DENY = { login: 404 } as const;
const P = '/api/v1/projects/PRJA';
const S = `${P}/standards`;
/** 없는 ID·importId — 허용 역할은 핸들러에서 404(도달 증명), 상태 불변. */
const MISSING = 999999;
const NO_IMPORT = '00000000-0000-4000-8000-000000000000';
const EMPTY_IMPORTS = {
  bizAreas: { source: 'EMPTY' },
  terms: { source: 'EMPTY' },
  domainClasses: { source: 'EMPTY' },
  domains: { source: 'EMPTY' },
  codes: { source: 'EMPTY' },
  defaultColSets: { source: 'EMPTY' },
};
const SETTINGS = {
  projectNm: '프로젝트 A',
  description: null,
  defaultDialect: 'POSTGRESQL',
  includeDefaultCols: true,
  defaultColSetId: null,
};

/**
 * 단계 6 표준 사전 행(§7.3: `P/standards/**` GET = 조회자 이상, 쓰기·imports·recalculate·approvals = PA).
 * 생성 요청은 seq로 키를 바꾸고, 삭제·없는 importId는 999999/빈 UUID로 404(도달)만 확인해 상태를 바꾸지 않는다.
 * 승인·반려는 첫 허용 역할이 처리하면 다음 역할은 상태 아님 409, 파일 없는 업로드는 422 E_IMPORT_FILE(도달).
 */
const STANDARD_ROWS: readonly MatrixRow[] = [
  {
    path: 'P/standards/terms',
    method: 'GET',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c) => c.get(`${S}/terms`),
  },
  {
    path: 'P/standards/terms/check',
    method: 'GET',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c) => c.get(`${S}/terms/check?termKor=%EC%9A%A9%EC%96%B41`),
  },
  {
    path: 'P/standards/terms/{id}',
    method: 'GET',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c, x) => c.get(`${S}/terms/${x.std.termId}`),
  },
  {
    path: 'P/standards/terms',
    method: 'POST',
    allow: PA_UP,
    ok: [201],
    denyByRole: P_DENY,
    run: (c, x) => c.post(`${S}/terms`, { termKor: `매트릭스${x.seq()}`, termPhysical: 'MTRX' }),
  },
  {
    path: 'P/standards/terms/{id}',
    method: 'PUT',
    allow: PA_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c, x) =>
      c.put(`${S}/terms/${x.std.termId}`, {
        termKor: '용어2',
        termPhysical: 'PA_T2',
        description: '설명 2',
      }),
  },
  {
    path: 'P/standards/terms/{id}',
    method: 'DELETE',
    allow: PA_UP,
    ok: [404],
    denyByRole: P_DENY,
    run: (c) => c.delete(`${S}/terms/${MISSING}`),
  },
  {
    path: 'P/standards/approvals',
    method: 'GET',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c) => c.get(`${S}/approvals`),
  },
  {
    path: 'P/standards/approvals/count',
    method: 'GET',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c) => c.get(`${S}/approvals/count`),
  },
  {
    path: 'P/standards/approvals/{termId}/approve',
    method: 'POST',
    allow: PA_UP,
    ok: [200, 409],
    denyByRole: P_DENY,
    run: (c, x) => c.post(`${S}/approvals/${x.std.pendingApproveId}/approve`, {}),
  },
  {
    path: 'P/standards/approvals/{termId}/reject',
    method: 'POST',
    allow: PA_UP,
    ok: [200, 409],
    denyByRole: P_DENY,
    run: (c, x) => c.post(`${S}/approvals/${x.std.pendingRejectId}/reject`, { note: '매트릭스' }),
  },
  {
    path: 'P/standards/approvals/approve-batch',
    method: 'POST',
    allow: PA_UP,
    ok: [409],
    denyByRole: P_DENY,
    run: (c, x) => c.post(`${S}/approvals/approve-batch`, { termIds: [x.std.termId] }),
  },
  {
    path: 'P/standards/domain-classes',
    method: 'GET',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c) => c.get(`${S}/domain-classes`),
  },
  {
    path: 'P/standards/domain-classes/{id}',
    method: 'GET',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c, x) => c.get(`${S}/domain-classes/${x.std.domainClsId}`),
  },
  {
    path: 'P/standards/domain-classes',
    method: 'POST',
    allow: PA_UP,
    ok: [201],
    denyByRole: P_DENY,
    run: (c, x) =>
      c.post(`${S}/domain-classes`, { suffix: `MX${x.seq()}`, clsNm: '매트릭스', colType: 'TEXT' }),
  },
  {
    path: 'P/standards/domain-classes/{id}',
    method: 'PUT',
    allow: PA_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c, x) =>
      c.put(`${S}/domain-classes/${x.std.domainClsId}`, {
        suffix: 'SFX01',
        clsNm: '분류1',
        colType: 'VARCHAR',
        colLength: 11,
      }),
  },
  {
    path: 'P/standards/domain-classes/{id}',
    method: 'DELETE',
    allow: PA_UP,
    ok: [404],
    denyByRole: P_DENY,
    run: (c) => c.delete(`${S}/domain-classes/${MISSING}`),
  },
  {
    path: 'P/standards/domains',
    method: 'GET',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c) => c.get(`${S}/domains?review=true`),
  },
  {
    path: 'P/standards/domains/{id}',
    method: 'GET',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c, x) => c.get(`${S}/domains/${x.std.domainId}`),
  },
  {
    path: 'P/standards/domains/calculate',
    method: 'POST',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c) => c.post(`${S}/domains/calculate`, { nm1: '용어1', nm2: '용어2' }),
  },
  {
    path: 'P/standards/domains',
    method: 'POST',
    allow: PA_UP,
    ok: [201],
    denyByRole: P_DENY,
    run: (c, x) => c.post(`${S}/domains`, { nm1: '용어1', nm2: `조각${x.seq()}` }),
  },
  {
    path: 'P/standards/domains/{id}',
    method: 'PUT',
    allow: PA_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c, x) => c.put(`${S}/domains/${x.std.domainId}`, { nm1: '용어9', nm2: '용어8' }),
  },
  {
    path: 'P/standards/domains/{id}',
    method: 'DELETE',
    allow: PA_UP,
    ok: [404],
    denyByRole: P_DENY,
    run: (c) => c.delete(`${S}/domains/${MISSING}`),
  },
  {
    path: 'P/standards/domains/recalculate',
    method: 'POST',
    allow: PA_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c) => c.post(`${S}/domains/recalculate`, { scope: 'REVIEW_ONLY' }),
  },
  {
    path: 'P/standards/code-classes',
    method: 'GET',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c) => c.get(`${S}/code-classes`),
  },
  {
    path: 'P/standards/code-classes/{id}',
    method: 'GET',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c, x) => c.get(`${S}/code-classes/${x.std.codeClsId}`),
  },
  {
    path: 'P/standards/code-classes/{id}/codes',
    method: 'GET',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c, x) => c.get(`${S}/code-classes/${x.std.codeClsId}/codes`),
  },
  {
    path: 'P/standards/code-classes',
    method: 'POST',
    allow: PA_UP,
    ok: [201],
    denyByRole: P_DENY,
    run: (c, x) =>
      c.post(`${S}/code-classes`, {
        bizAreaId: x.bizRpId,
        codeCls: `M${x.seq()}`,
        codeClsNm: '매트릭스',
      }),
  },
  {
    path: 'P/standards/code-classes/{id}',
    method: 'PUT',
    allow: PA_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c, x) =>
      c.put(`${S}/code-classes/${x.std.codeClsId}`, {
        bizAreaId: x.bizRpId,
        codeCls: 'RP001',
        codeClsNm: '코드구분1',
      }),
  },
  {
    path: 'P/standards/code-classes/{id}',
    method: 'DELETE',
    allow: PA_UP,
    ok: [404],
    denyByRole: P_DENY,
    run: (c) => c.delete(`${S}/code-classes/${MISSING}`),
  },
  {
    path: 'P/standards/code-classes/{id}/codes',
    method: 'POST',
    allow: PA_UP,
    ok: [201],
    denyByRole: P_DENY,
    run: (c, x) =>
      c.post(`${S}/code-classes/${x.std.codeClsId}/codes`, {
        code: `M${x.seq()}`,
        codeNm: '매트릭스',
      }),
  },
  {
    path: 'P/standards/code-classes/{id}/codes/{codeId}',
    method: 'PUT',
    allow: PA_UP,
    ok: [404],
    denyByRole: P_DENY,
    run: (c, x) =>
      c.put(`${S}/code-classes/${x.std.codeClsId}/codes/${MISSING}`, { code: 'X', codeNm: 'x' }),
  },
  {
    path: 'P/standards/code-classes/{id}/codes/{codeId}',
    method: 'DELETE',
    allow: PA_UP,
    ok: [404],
    denyByRole: P_DENY,
    run: (c, x) => c.delete(`${S}/code-classes/${x.std.codeClsId}/codes/${MISSING}`),
  },
  {
    path: 'P/standards/default-column-sets',
    method: 'GET',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c) => c.get(`${S}/default-column-sets`),
  },
  {
    path: 'P/standards/default-column-sets/{id}',
    method: 'GET',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c, x) => c.get(`${S}/default-column-sets/${x.std.setId}`),
  },
  {
    path: 'P/standards/default-column-sets',
    method: 'POST',
    allow: PA_UP,
    ok: [201],
    denyByRole: P_DENY,
    run: (c, x) => c.post(`${S}/default-column-sets`, { setNm: `매트릭스${x.seq()}` }),
  },
  {
    path: 'P/standards/default-column-sets/{id}',
    method: 'PUT',
    allow: PA_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c, x) => c.put(`${S}/default-column-sets/${x.std.setId}`, { setNm: '기본' }),
  },
  {
    path: 'P/standards/default-column-sets/{id}/columns',
    method: 'PUT',
    allow: PA_UP,
    ok: [404],
    denyByRole: P_DENY,
    run: (c) => c.put(`${S}/default-column-sets/${MISSING}/columns`, { columns: [] }),
  },
  {
    path: 'P/standards/default-column-sets/{id}/default',
    method: 'PUT',
    allow: PA_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c, x) => c.put(`${S}/default-column-sets/${x.std.setId}/default`),
  },
  {
    path: 'P/standards/default-column-sets/{id}',
    method: 'DELETE',
    allow: PA_UP,
    ok: [404],
    denyByRole: P_DENY,
    run: (c) => c.delete(`${S}/default-column-sets/${MISSING}`),
  },
  {
    path: 'P/standards/audit-logs',
    method: 'GET',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c) => c.get(`${S}/audit-logs`),
  },
  {
    path: 'P/standards/{kind}/imports/template',
    method: 'GET',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c) => c.get(`${S}/terms/imports/template`),
  },
  {
    path: 'P/standards/{kind}/imports',
    method: 'POST',
    allow: PA_UP,
    ok: [422],
    denyByRole: P_DENY,
    run: (c) => c.post(`${S}/terms/imports`, {}),
  },
  {
    path: 'P/standards/imports/{importId}',
    method: 'GET',
    allow: PA_UP,
    ok: [404],
    denyByRole: P_DENY,
    run: (c) => c.get(`${S}/imports/${NO_IMPORT}`),
  },
  {
    path: 'P/standards/imports/{importId}/apply',
    method: 'POST',
    allow: PA_UP,
    ok: [404],
    denyByRole: P_DENY,
    run: (c) => c.post(`${S}/imports/${NO_IMPORT}/apply`, {}),
  },
  {
    path: 'P/standards/imports/{importId}',
    method: 'DELETE',
    allow: PA_UP,
    ok: [404],
    denyByRole: P_DENY,
    run: (c) => c.delete(`${S}/imports/${NO_IMPORT}`),
  },
  {
    path: 'P/search',
    method: 'GET',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c) => c.get(`${P}/search?q=%EC%9A%A9%EC%96%B4`),
  },
];

/**
 * 단계 7 테이블 목록·DDL 행(§7.3: `P/tables`(GET)·`P/ddl/**`·`P/tables/{id}/ddl`·`P/export-logs` = 조회자 이상).
 * DDL·정보 추출·복사 기록은 조회성 POST(보관 프로젝트 허용) — 기록 행이 늘 뿐 상태는 바뀌지 않는다.
 */
const DDL_ROWS: readonly MatrixRow[] = [
  {
    path: 'P/tables',
    method: 'GET',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c) => c.get(`${P}/tables`),
  },
  {
    path: 'P/tables/{id}/ddl',
    method: 'GET',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c, x) => c.get(`${P}/tables/${x.tableId}/ddl`),
  },
  {
    path: 'P/ddl',
    method: 'POST',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c, x) => c.post(`${P}/ddl`, { tableIds: [x.tableId] }),
  },
  {
    path: 'P/ddl/extract',
    method: 'POST',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c, x) => c.post(`${P}/ddl/extract`, { tableIds: [x.tableId] }),
  },
  {
    path: 'P/export-logs',
    method: 'POST',
    allow: VIEWER_UP,
    ok: [201],
    denyByRole: P_DENY,
    run: (c, x) => c.post(`${P}/export-logs`, { kind: 'COPY', tableIds: [x.tableId] }),
  },
  {
    path: 'P/export-logs',
    method: 'GET',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c) => c.get(`${P}/export-logs`),
  },
];

/**
 * 단계 8 테이블 설계 행(§7.3: 조회 = 조회자, 쓰기·검증·복제·복원·→FINAL = 편집자, FINAL→DRAFT·FINAL 삭제 = 프로젝트 관리자).
 * 상태를 바꾸지 않도록: 저장은 version 1(첫 허용 역할만 200, 이후 409 충돌), 상태·복원은 없는 version(409 충돌 = 도달),
 * DRAFT 삭제는 없는 ID(404). 확정 해제·FINAL 삭제는 역할 판정이 서비스에 있다(편집자 403) — FINAL 테이블은 PA가 지운다(SA는 404).
 */
const EDITOR_UP: readonly Role[] = ['editor', 'pa', 'sa'];
const tableBody = (tableNm: string, bizAreaId: number) => ({
  table: { bizAreaId, tableNm, tableLogicalNm: '매트릭스', description: null },
  columns: [
    {
      columnId: null,
      logicalNm: '연구과제ID',
      physicalNm: 'RSCH_PRJ_ID',
      isPk: true,
      dataType: 'VARCHAR',
      dataLength: 20,
      colComment: '연구과제ID',
    },
  ],
});
const TABLE_ROWS: readonly MatrixRow[] = [
  {
    path: 'P/tables/{id}',
    method: 'GET',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c, x) => c.get(`${P}/tables/${x.tableId}`),
  },
  {
    path: 'P/tables',
    method: 'POST',
    allow: EDITOR_UP,
    ok: [201],
    denyByRole: P_DENY,
    run: (c, x) => c.post(`${P}/tables`, tableBody(`RP_MX${x.seq()}`, x.bizRpId)),
  },
  {
    path: 'P/tables/validate',
    method: 'POST',
    allow: EDITOR_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c, x) => c.post(`${P}/tables/validate`, tableBody('RP_MX_VALIDATE', x.bizRpId)),
  },
  {
    path: 'P/tables/{id}',
    method: 'PUT',
    allow: EDITOR_UP,
    ok: [200, 409],
    denyByRole: P_DENY,
    run: (c, x) =>
      c.put(`${P}/tables/${x.tableId}`, {
        version: 1,
        ...tableBody('RP_RSCH_PRJ_MST', x.bizRpId),
      }),
  },
  {
    path: 'P/tables/{id}',
    method: 'DELETE',
    allow: EDITOR_UP,
    ok: [404],
    denyByRole: P_DENY,
    run: (c) => c.delete(`${P}/tables/${MISSING}`),
  },
  {
    path: 'P/tables/{id}/status(→FINAL)',
    method: 'PUT',
    allow: EDITOR_UP,
    ok: [409],
    denyByRole: P_DENY,
    run: (c, x) => c.put(`${P}/tables/${x.tableId}/status`, { status: 'FINAL', version: MISSING }),
  },
  {
    path: 'P/tables/{id}/clone',
    method: 'POST',
    allow: EDITOR_UP,
    ok: [201],
    denyByRole: P_DENY,
    run: (c, x) => c.post(`${P}/tables/${x.tableId}/clone`, {}),
  },
  {
    path: 'P/tables/{id}/history',
    method: 'GET',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c, x) => c.get(`${P}/tables/${x.tableId}/history`),
  },
  {
    path: 'P/tables/{id}/history/{v}',
    method: 'GET',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c, x) => c.get(`${P}/tables/${x.tableId}/history/1`),
  },
  {
    path: 'P/tables/{id}/history/{v}/restore',
    method: 'POST',
    allow: EDITOR_UP,
    ok: [409],
    denyByRole: P_DENY,
    run: (c, x) => c.post(`${P}/tables/${x.tableId}/history/1/restore`, { version: MISSING }),
  },
  {
    path: 'P/tables/{id}/status(FINAL→DRAFT)',
    method: 'PUT',
    allow: PA_UP,
    ok: [409],
    denyByRole: P_DENY,
    run: (c, x) =>
      c.put(`${P}/tables/${x.finalTableId}/status`, { status: 'DRAFT', version: MISSING }),
  },
  {
    path: 'P/tables/{id}(FINAL)',
    method: 'DELETE',
    allow: PA_UP,
    ok: [204, 404],
    denyByRole: P_DENY,
    run: (c, x) => c.delete(`${P}/tables/${x.finalTableId}`),
  },
];

/**
 * 단계 9 자동완성 행(§7.3: `P/autocomplete/**`·`P/tables/suggest-name`·`P/standards/terms/inline` = 편집자 이상 POST,
 * `/admin/cache/**` = 시스템 관리자). 인라인 등록은 역할마다 다른 한글 용어(seq)로 201.
 */
const AUTOCOMPLETE_ROWS: readonly MatrixRow[] = [
  {
    path: 'P/autocomplete/columns',
    method: 'POST',
    allow: EDITOR_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c) => c.post(`${P}/autocomplete/columns`, { logicalNm: '용어1용어2' }),
  },
  {
    path: 'P/autocomplete/columns/batch',
    method: 'POST',
    allow: EDITOR_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c) => c.post(`${P}/autocomplete/columns/batch`, { logicalNms: ['용어1', '용어2'] }),
  },
  {
    path: 'P/tables/suggest-name',
    method: 'POST',
    allow: EDITOR_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c, x) =>
      c.post(`${P}/tables/suggest-name`, { logicalNm: '용어1용어2', bizAreaId: x.bizRpId }),
  },
  {
    path: 'P/standards/terms/inline',
    method: 'POST',
    allow: EDITOR_UP,
    ok: [201],
    denyByRole: P_DENY,
    run: (c, x) => {
      const n = x.seq();
      return c.post(`${S}/terms/inline`, { termKor: `매트릭스${n}`, termPhysical: `MXI${n}` });
    },
  },
  {
    path: '/admin/cache',
    method: 'GET',
    allow: SA,
    ok: [200],
    run: (c) => c.get('/api/v1/admin/cache'),
  },
  {
    path: '/admin/cache/{key}/reload',
    method: 'POST',
    allow: SA,
    ok: [200],
    run: (c) => c.post('/api/v1/admin/cache/PRJA/reload'),
  },
];

export const AUTHZ_MATRIX: readonly MatrixRow[] = [
  // ── 인증(§7.3 1행) ─────────────────────────────────────────────
  {
    path: '/auth/csrf',
    method: 'GET',
    allow: ALL,
    ok: [200],
    run: (c) => c.get('/api/v1/auth/csrf'),
  },
  {
    path: '/auth/login',
    method: 'POST',
    allow: ALL,
    ok: [200],
    run: (c, x) =>
      c.post(
        '/api/v1/auth/login',
        { loginId: 'viewer', password: x.fixturePassword },
        { form: true },
      ),
  },
  // ── 내 계정(§7.3 2행) ──────────────────────────────────────────
  {
    path: '/auth/logout',
    method: 'POST',
    allow: LOGGED_IN,
    ok: [204],
    run: (c) => c.post('/api/v1/auth/logout'),
  },
  { path: '/me', method: 'GET', allow: LOGGED_IN, ok: [200], run: (c) => c.get('/api/v1/me') },
  {
    path: '/me/password',
    method: 'PUT',
    allow: LOGGED_IN,
    // 현재 비밀번호를 일부러 틀려 비밀번호를 바꾸지 않는다(도달 = 422)
    ok: [422],
    run: (c) =>
      c.put('/api/v1/me/password', {
        currentPassword: 'not-the-current-1',
        newPassword: 'Matrix#2026pw',
      }),
  },
  // ── 시스템·사용자(§7.3 마지막 행) ────────────────────────────────
  {
    path: '/admin/users',
    method: 'GET',
    allow: SA,
    ok: [200],
    run: (c) => c.get('/api/v1/admin/users'),
  },
  {
    path: '/admin/users',
    method: 'POST',
    allow: SA,
    ok: [201],
    run: (c, x) => c.post('/api/v1/admin/users', { loginId: `mx${x.seq()}`, userNm: '매트릭스' }),
  },
  {
    path: '/admin/users/{id}',
    method: 'GET',
    allow: SA,
    ok: [200],
    run: (c, x) => c.get(`/api/v1/admin/users/${x.targetUserId}`),
  },
  {
    path: '/admin/users/{id}',
    method: 'PUT',
    allow: SA,
    ok: [200],
    run: (c, x) =>
      c.put(`/api/v1/admin/users/${x.targetUserId}`, {
        userNm: '대상',
        email: null,
        isSysAdmin: false,
      }),
  },
  {
    path: '/admin/users/{id}/active',
    method: 'PUT',
    allow: SA,
    ok: [200],
    run: (c, x) => c.put(`/api/v1/admin/users/${x.targetUserId}/active`, { isActive: true }),
  },
  {
    path: '/admin/users/{id}/reset-password',
    method: 'POST',
    allow: SA,
    ok: [200],
    run: (c, x) => c.post(`/api/v1/admin/users/${x.targetUserId}/reset-password`),
  },
  {
    path: '/admin/users/{id}/unlock',
    method: 'POST',
    allow: SA,
    ok: [200],
    run: (c, x) => c.post(`/api/v1/admin/users/${x.targetUserId}/unlock`),
  },

  // ── 프로젝트 전역(§7.3 3·4행) ─────────────────────────────────────
  {
    path: '/projects',
    method: 'GET',
    allow: LOGGED_IN,
    ok: [200],
    run: (c) => c.get('/api/v1/projects'),
  },
  {
    path: '/projects/copy-sources',
    method: 'GET',
    allow: LOGGED_IN,
    ok: [200],
    run: (c) => c.get('/api/v1/projects/copy-sources'),
  },
  {
    path: '/projects/check-key',
    method: 'GET',
    allow: SA,
    ok: [200],
    run: (c) => c.get('/api/v1/projects/check-key?key=MXNEW'),
  },
  {
    path: '/projects/copy-preview',
    method: 'POST',
    allow: SA,
    ok: [200],
    run: (c) => c.post('/api/v1/projects/copy-preview', { imports: EMPTY_IMPORTS }),
  },
  {
    path: '/projects',
    method: 'POST',
    allow: SA,
    ok: [201],
    run: (c, x) =>
      c.post('/api/v1/projects', {
        projectKey: `MX${x.seq()}`,
        projectNm: '매트릭스',
        imports: EMPTY_IMPORTS,
      }),
  },
  // ── P 조회(§7.3 5행) · P/settings·copy-log ──────────────────────
  {
    path: 'P',
    method: 'GET',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c) => c.get(P),
  },
  {
    path: 'P/settings',
    method: 'GET',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c) => c.get(`${P}/settings`),
  },
  {
    path: 'P/settings',
    method: 'PUT',
    allow: PA_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c) => c.put(`${P}/settings`, SETTINGS),
  },
  {
    path: 'P/copy-log',
    method: 'GET',
    allow: PA_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c) => c.get(`${P}/copy-log`),
  },
  // ── 멤버(§7.3 P/members/**) ─────────────────────────────────────
  {
    path: 'P/members',
    method: 'GET',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c) => c.get(`${P}/members`),
  },
  {
    path: 'P/member-candidates',
    method: 'GET',
    allow: PA_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c) => c.get(`${P}/member-candidates?q=`),
  },
  {
    path: 'P/members',
    method: 'POST',
    allow: PA_UP,
    // 두 번째 허용 역할은 이미 멤버 → 409(핸들러 도달)
    ok: [201, 409],
    denyByRole: P_DENY,
    run: (c, x) => c.post(`${P}/members`, { userId: x.targetUserId, role: 'VIEWER' }),
  },
  {
    path: 'P/members/{userId}',
    method: 'PUT',
    allow: PA_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c, x) => c.put(`${P}/members/${x.paUserId}`, { role: 'ADMIN' }),
  },
  {
    path: 'P/members/{userId}',
    method: 'DELETE',
    allow: PA_UP,
    // 유일한 프로젝트 관리자 제거 시도 → 409 E_LAST_PROJECT_ADMIN(핸들러 도달, 상태 불변)
    ok: [409],
    denyByRole: P_DENY,
    run: (c, x) => c.delete(`${P}/members/${x.paUserId}`),
  },
  // ── 업무구분(§7.3 P/biz-areas) ──────────────────────────────────
  {
    path: 'P/biz-areas',
    method: 'GET',
    allow: VIEWER_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c) => c.get(`${P}/biz-areas`),
  },
  {
    path: 'P/biz-areas',
    method: 'POST',
    allow: PA_UP,
    ok: [201],
    denyByRole: P_DENY,
    run: (c, x) => c.post(`${P}/biz-areas`, { bizCd: `MX${x.seq()}`, bizNm: '매트릭스' }),
  },
  {
    path: 'P/biz-areas/{id}',
    method: 'PUT',
    allow: PA_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c, x) =>
      c.put(`${P}/biz-areas/${x.bizPsId}`, {
        bizCd: 'PS',
        bizNm: '인사',
        tablePrefix: 'PS_',
        sortNo: 2,
        useYn: true,
      }),
  },
  {
    path: 'P/biz-areas/{id}/delete-preview',
    method: 'GET',
    allow: PA_UP,
    ok: [200],
    denyByRole: P_DENY,
    run: (c, x) => c.get(`${P}/biz-areas/${x.bizPsId}/delete-preview`),
  },
  {
    path: 'P/biz-areas/{id}',
    method: 'DELETE',
    allow: PA_UP,
    // 테이블이 있는 RP → 409 E_BIZ_AREA_IN_USE(핸들러 도달, 상태 불변)
    ok: [409],
    denyByRole: P_DENY,
    run: (c, x) => c.delete(`${P}/biz-areas/${x.bizRpId}`),
  },
  // ── 시스템 › 프로젝트·템플릿(§7.3 마지막 행) ──────────────────────
  {
    path: '/admin/projects',
    method: 'GET',
    allow: SA,
    ok: [200],
    run: (c) => c.get('/api/v1/admin/projects'),
  },
  {
    path: '/admin/projects/{key}/status',
    method: 'PUT',
    allow: SA,
    ok: [200],
    run: (c) => c.put('/api/v1/admin/projects/PRJB/status', { status: 'ACTIVE' }),
  },
  {
    path: '/admin/projects/{key}',
    method: 'DELETE',
    allow: SA,
    // ACTIVE 프로젝트 → 409 E_PROJECT_ACTIVE(삭제되지 않음)
    ok: [409],
    run: (c) => c.delete('/api/v1/admin/projects/PRJA', { confirmKey: 'PRJA' }),
  },
  {
    path: '/admin/templates',
    method: 'GET',
    allow: SA,
    ok: [200],
    run: (c) => c.get('/api/v1/admin/templates'),
  },
  {
    path: '/admin/templates',
    method: 'POST',
    allow: SA,
    ok: [201],
    run: (c, x) =>
      c.post('/api/v1/admin/templates', {
        sourceProjectKey: 'PRJB',
        projectKey: `MXT${x.seq()}`,
        projectNm: '매트릭스 템플릿',
      }),
  },
  {
    path: '/admin/templates/{key}/status',
    method: 'PUT',
    allow: SA,
    ok: [200],
    run: (c) => c.put('/api/v1/admin/templates/STDS/status', { status: 'ACTIVE' }),
  },
  {
    path: '/admin/templates/{key}',
    method: 'DELETE',
    allow: SA,
    // 파생 프로젝트(PRJA)가 있는 STDS → 409 E_TEMPLATE_IN_USE(삭제되지 않음)
    ok: [409],
    run: (c) => c.delete('/api/v1/admin/templates/STDS', { confirmKey: 'STDS' }),
  },
  ...STANDARD_ROWS,
  ...DDL_ROWS,
  ...TABLE_ROWS,
  ...AUTOCOMPLETE_ROWS,
];
