import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import type {
  BizAreaItem,
  DdlResponse,
  MyProject,
  TableListItem,
  TablePage,
} from '@termflow/shared';
import { api } from '../api/client.js';
import DdlCode from '../components/ddl/DdlCode.vue';
import { tokenizeLine } from '../components/ddl/highlight.js';
import AppShell from '../components/layout/AppShell.vue';
import { createAppRouter } from '../router.js';
import { useSessionStore } from '../stores/session.js';
import {
  fakeFetch,
  json,
  problem,
  untilRoute,
  type FakeRequest,
  type Handler,
} from '../test-utils.js';
import DdlExportPage from './DdlExportPage.vue';
import TablesPage from './TablesPage.vue';

// T7.12 화면: 테이블 목록(09)·DDL 내보내기(10)·구문 강조 컴포넌트 — S3 다중(클릭 3 / 이동 1)
const USER = { id: 5, loginId: 'viewer', userNm: '조회자', isSysAdmin: false };
const proj: MyProject = {
  key: 'RMS',
  nm: '연구관리시스템(이관)',
  role: 'VIEWER',
  kind: 'PROJECT',
  status: 'ACTIVE',
};
const P = '/api/v1/projects/RMS';

const biz = (over: Partial<BizAreaItem>): BizAreaItem => ({
  bizAreaId: 6,
  bizCd: 'RP',
  bizNm: '연구과제',
  tablePrefix: 'RP_',
  sortNo: 6,
  useYn: true,
  description: null,
  tableCnt: 3,
  codeClsCnt: 0,
  locked: true,
  origin: null,
  ...over,
});
const BIZ = [
  biz({}),
  biz({ bizAreaId: 1, bizCd: 'AC', bizNm: '회계', tableCnt: 0, locked: false }),
];
const row = (id: number, nm: string, over: Partial<TableListItem> = {}): TableListItem => ({
  tableId: id,
  bizAreaId: 6,
  bizCd: 'RP',
  tableNm: nm,
  logicalNm: `${nm} 논리`,
  status: 'FINAL',
  version: 1,
  colCnt: 10,
  updatedBy: 'MIGRATION',
  updatedAt: '2026-03-26T15:07:00',
  errorCnt: 0,
  warningCnt: 0,
  issues: [],
  reviewYn: false,
  reviewNote: null,
  ...over,
});
const ROWS = [
  row(1, 'RP_A'),
  row(2, 'RP_B', { warningCnt: 1, issues: [{ code: 'W_PK_NONE', message: 'PK가 없습니다' }] }),
  row(3, 'RP_C', { status: 'DRAFT' }),
];
const tablePage = (items: TableListItem[]): TablePage => ({
  items,
  page: 1,
  size: 50,
  total: items.length,
  bizAreaCounts: [{ bizAreaId: 6, cnt: 3 }],
  allCnt: 3,
  statusCounts: { DRAFT: 1, FINAL: 2 },
});
const sqlOf = (nm: string) =>
  `-- TermFlow DDL | 프로젝트 RMS 연구관리시스템(이관) · 업무구분 RP | 방언 POSTGRESQL | 2026-09-29 10:00 | viewer\nCREATE TABLE ${nm} (\n    ID                   VARCHAR(20)    NOT NULL,\n    CONSTRAINT PK_${nm} PRIMARY KEY (ID)\n);\nCOMMENT ON TABLE  ${nm} IS '${nm} 논리';\n`;
function ddlResponse(ids: number[]): DdlResponse {
  const ts = ids.map((id) => ROWS.find((r) => r.tableId === id)!);
  return {
    dialect: 'POSTGRESQL',
    tableCnt: ts.length,
    sql: ts.map((t) => sqlOf(t.tableNm)).join('\n\n'),
    files: [{ name: 'RMS_POSTGRESQL_20260929_1000.sql', size: 100 }],
    tables: ts.map((t) => ({
      tableId: t.tableId,
      tableNm: t.tableNm,
      logicalNm: t.logicalNm,
      bizCd: 'RP',
      status: t.status,
      version: 1,
      colCnt: t.colCnt,
      sql: sqlOf(t.tableNm),
      warningCnt: t.warningCnt,
    })),
    warnings: ts
      .filter((t) => t.warningCnt > 0)
      .map((t) => ({
        code: 'W_PK_NONE',
        target: 'table' as const,
        message: 'PK가 없습니다',
        tableNm: t.tableNm,
      })),
  };
}

async function setup(path: string, routes: Record<string, Handler>) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const f = fakeFetch({
    'GET /api/v1/auth/csrf': () => json(200, { token: 'T' }),
    'GET /api/v1/me': () => json(200, { user: USER, mustChangePassword: false, projects: [proj] }),
    [`GET ${P}/biz-areas`]: () => json(200, BIZ),
    [`GET ${P}/export-logs`]: () => json(200, { items: [], page: 1, size: 5, total: 0 }),
    ...routes,
  });
  vi.stubGlobal('fetch', f.fetch);
  api.setCsrfToken(null);
  const router = createAppRouter(createMemoryHistory());
  await useSessionStore().refresh();
  await router.push(path);
  return { pinia, router, calls: f.calls };
}
const bodies = (calls: FakeRequest[], method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === path).map((c) => JSON.parse(c.body!));
const button = (w: VueWrapper, text: string) =>
  w.findAll('button').find((b) => b.text().includes(text))!;
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
beforeEach(() => localStorage.clear());

describe('DDL 구문 강조(kw·ty·id·str·num·cm)', () => {
  it("토큰 분류: 키워드·타입·식별자·문자열('' 이스케이프)·숫자·주석·인용 식별자", () => {
    const kinds = (s: string) =>
      tokenizeLine(s)
        .filter((t) => t.k)
        .map((t) => [t.k, t.v]);
    expect(kinds("    END_YN               VARCHAR(1)     NOT NULL DEFAULT 'N',")).toEqual([
      ['id', 'END_YN'],
      ['ty', 'VARCHAR'],
      ['num', '1'],
      ['kw', 'NOT'],
      ['kw', 'NULL'],
      ['kw', 'DEFAULT'],
      ['str', "'N'"],
    ]);
    expect(kinds("COMMENT ON COLUMN T.C IS '고객''s -- 메모';")).toEqual([
      ['kw', 'COMMENT'],
      ['kw', 'ON'],
      ['kw', 'COLUMN'],
      ['id', 'T'],
      ['id', 'C'],
      ['kw', 'IS'],
      ['str', "'고객''s -- 메모'"],
    ]);
    expect(kinds('-- TermFlow DDL | 방언 POSTGRESQL')).toEqual([
      ['cm', '-- TermFlow DDL | 방언 POSTGRESQL'],
    ]);
    expect(kinds('    "ORDER" INTEGER')).toEqual([
      ['id', '"ORDER"'],
      ['ty', 'INTEGER'],
    ]);
    expect(kinds('NUMERIC(6,2) RP_A1')).toEqual([
      ['ty', 'NUMERIC'],
      ['num', '6'],
      ['num', '2'],
      ['id', 'RP_A1'],
    ]);
  });

  it('DdlCode: 줄마다 .l, 토큰 클래스, 마크업은 텍스트로(v-html 없음), 경고 컬럼 줄 강조', () => {
    const w = mount(DdlCode, {
      props: {
        sql: '-- <b>x</b>\nCREATE TABLE T (\n    MEMO                 VARCHAR(10)\n);\n',
        warnColumns: ['MEMO'],
      },
    });
    expect(w.findAll('.l')).toHaveLength(4);
    expect(w.find('b').exists()).toBe(false);
    expect(w.get('.cm').text()).toBe('-- <b>x</b>');
    expect(w.findAll('.kw').map((s) => s.text())).toEqual(['CREATE', 'TABLE']);
    expect(w.get('.ty').text()).toBe('VARCHAR');
    expect(w.findAll('.l.warn')).toHaveLength(1);
    expect(w.findAll('.l.warn')[0]!.text()).toContain('MEMO');
    expect(w.get('pre').text()).toContain('CREATE TABLE T (');
  });
});

describe('TablesPage(09)', () => {
  it('업무구분 목록·건수, 상태 칩, 검증 배지, 행 물리명 → DDL 미리보기, 사이드바 링크 활성', async () => {
    const { pinia, router, calls } = await setup('/projects/RMS/tables', {
      [`GET ${P}/tables`]: () => json(200, tablePage(ROWS)),
    });
    const w = mount(AppShell, {
      global: { plugins: [pinia, router] },
      slots: { default: TablesPage },
    });
    await flushPromises();
    expect(w.get('[aria-label="업무구분 필터"]').text()).toMatch(/전체\s*3/);
    expect(w.get('[aria-label="업무구분 필터"]').text()).toMatch(/RP\s*연구과제\s*3/);
    expect(w.get('[aria-label="상태 필터"]').text()).toMatch(/DRAFT\s*1/);
    expect(w.text()).toContain('PK 없음');
    const link = w.find('a[href="/projects/RMS/export?tableIds=1"]');
    expect(link.exists()).toBe(true);
    expect(w.find('a[href="/projects/RMS/tables"]').exists()).toBe(true);
    expect(w.find('a[href="/projects/RMS/export"]').exists()).toBe(true);
    // 업무구분 클릭 → bizAreaId 필터
    const rp = w.findAll('.tree-node').find((n) => n.text().includes('연구과제'))!;
    await rp.trigger('click');
    await flushPromises();
    expect(
      calls
        .filter((c) => c.path === `${P}/tables`)
        .at(-1)!
        .query.get('bizAreaId'),
    ).toBe('6');
    w.unmount();
  });

  it('S3 다중: 전체 선택(1) → DDL 내보내기(2, 이동 1) → 다운로드(3) — .sql 요청은 선택 순서', async () => {
    const saved: string[] = [];
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }),
    );
    const { pinia, router, calls } = await setup('/projects/RMS/tables', {
      [`GET ${P}/tables`]: () => json(200, tablePage(ROWS)),
      [`POST ${P}/ddl`]: (r) => {
        const b = JSON.parse(r.body!) as { tableIds: number[]; output: string };
        if (b.output === 'SQL') {
          saved.push(b.tableIds.join(','));
          return new Response('-- sql', {
            status: 200,
            headers: {
              'Content-Disposition': 'attachment; filename="RMS_POSTGRESQL_20260929_1000.sql"',
            },
          });
        }
        return json(200, ddlResponse(b.tableIds));
      },
    });
    const w = mount(AppShell, {
      global: { plugins: [pinia, router] },
      slots: { default: TablesPage },
      attachTo: document.body,
    });
    await flushPromises();
    let clicks = 0;
    await w.get('input[aria-label="전체 선택"]').setValue(true);
    clicks++;
    expect(w.get('[data-testid="selected-count"]').text()).toBe('3');
    await button(w, 'DDL 내보내기').trigger('click');
    clicks++;
    await untilRoute(router, '/projects/RMS/export');
    expect(router.currentRoute.value.query['tableIds']).toBe('1,2,3');
    w.unmount();

    const e = mount(DdlExportPage, {
      global: { plugins: [pinia, router] },
      attachTo: document.body,
    });
    await flushPromises();
    await new Promise((r) => setTimeout(r, 350));
    await flushPromises();
    expect(e.get('[data-testid="selected-tables"]').text()).toContain('RP_A');
    expect(e.get('[data-testid="ddl-code"]').text()).toContain('CREATE TABLE RP_A (');
    await e.get('[data-testid="download-primary"]').trigger('click');
    clicks++;
    await flushPromises();
    expect(saved).toEqual(['1,2,3']);
    expect(clicks).toBe(3);
    const posted = bodies(calls, 'POST', `${P}/ddl`).at(-1);
    expect(posted).toMatchObject({ tableIds: [1, 2, 3], output: 'SQL', dialect: 'POSTGRESQL' });
    e.unmount();
  });
});

describe('DdlExportPage(10)', () => {
  it('옵션 변경 → 다시 생성(서버 옵션 전달), 복사 = 클립보드 + 기록 COPY, 정보 추출 탭', async () => {
    const writes: string[] = [];
    vi.stubGlobal('navigator', {
      clipboard: { writeText: (t: string) => (writes.push(t), Promise.resolve()) },
    });
    const { pinia, router, calls } = await setup('/projects/RMS/export?tableIds=2,1', {
      [`POST ${P}/ddl`]: (r) =>
        json(200, ddlResponse((JSON.parse(r.body!) as { tableIds: number[] }).tableIds)),
      [`POST ${P}/ddl/extract`]: () =>
        json(200, {
          dialect: 'POSTGRESQL',
          tableCnt: 2,
          rowCnt: 2,
          text: '업무구분\t테이블물리명\nRP\tRP_B\n',
          fileName: 'RMS_tables_20260929_1000.tsv',
        }),
      [`POST ${P}/export-logs`]: () => json(201, { exportId: 1 }),
    });
    const w = mount(DdlExportPage, {
      global: { plugins: [pinia, router] },
      attachTo: document.body,
    });
    await flushPromises();
    await new Promise((r) => setTimeout(r, 350));
    await flushPromises();
    // 순서 = 진입 순서(RP_B, RP_A)
    const names = w
      .get('[data-testid="selected-tables"]')
      .findAll('table .mono')
      .map((m) => m.text());
    expect(names.slice(0, 2)).toEqual(['RP_B', 'RP_A']);
    expect(w.get('[data-testid="ddl-warnings"]').text()).toContain('PK 없음');

    await w.get('[data-testid="ddl-options"]').findAll('input[type="checkbox"]')[0]!.setValue(true);
    await new Promise((r) => setTimeout(r, 350));
    await flushPromises();
    expect(bodies(calls, 'POST', `${P}/ddl`).at(-1)).toMatchObject({
      tableIds: [2, 1],
      output: 'JSON',
      options: { dropIfExists: true },
    });

    await button(w, '복사').trigger('click');
    await flushPromises();
    expect(writes[0]).toContain('CREATE TABLE RP_B (');
    expect(bodies(calls, 'POST', `${P}/export-logs`).at(-1)).toMatchObject({
      kind: 'COPY',
      tableIds: [2, 1],
      warningCnt: 1,
    });

    await w.findAll('[role="tab"]')[1]!.trigger('click');
    await flushPromises();
    expect(w.get('[data-testid="extract-text"]').text()).toContain('RP\tRP_B');
    w.unmount();
  });

  it('오류(422): 경고 카드에 오류 표시 → [오류 테이블 제외]로 선택에서 뺀다, 다운로드 비활성', async () => {
    const { pinia, router } = await setup('/projects/RMS/export?tableIds=1,3', {
      [`GET ${P}/tables`]: () => json(200, tablePage(ROWS)),
      [`POST ${P}/ddl`]: (r) => {
        const ids = (JSON.parse(r.body!) as { tableIds: number[] }).tableIds;
        if (ids.includes(3)) {
          return problem(422, 'validation', 'E_VALIDATION', {
            detail: '오류 1건(테이블 1개)',
            errors: [
              {
                code: 'E_RESERVED',
                target: 'column',
                message: 'ORDER은(는) PostgreSQL 예약어입니다',
                tableNm: 'RP_C',
                columnNm: 'ORDER',
              },
            ],
            warnings: [],
          });
        }
        return json(200, ddlResponse(ids));
      },
    });
    const w = mount(DdlExportPage, {
      global: { plugins: [pinia, router] },
      attachTo: document.body,
    });
    await flushPromises();
    await new Promise((r) => setTimeout(r, 350));
    await flushPromises();
    const warn = w.get('[data-testid="ddl-warnings"]');
    expect(warn.text()).toContain('ORDER은(는) PostgreSQL 예약어입니다');
    expect(w.get('[data-testid="download-primary"]').attributes('disabled')).toBeDefined();
    await button(w, '오류 테이블 제외').trigger('click');
    await new Promise((r) => setTimeout(r, 350));
    await flushPromises();
    expect(w.get('[data-testid="selected-tables"]').text()).not.toContain('RP_C');
    expect(w.get('[data-testid="ddl-code"]').text()).toContain('CREATE TABLE RP_A (');
    expect(w.get('[data-testid="download-primary"]').attributes('disabled')).toBeUndefined();
    w.unmount();
  });

  it('선택이 없으면 업무구분 전체 추가 버튼 → 업무구분의 테이블로 채운다', async () => {
    const { pinia, router, calls } = await setup('/projects/RMS/export', {
      [`GET ${P}/tables`]: () => json(200, tablePage(ROWS)),
      [`POST ${P}/ddl`]: (r) =>
        json(200, ddlResponse((JSON.parse(r.body!) as { tableIds: number[] }).tableIds)),
    });
    const w = mount(DdlExportPage, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(w.text()).toContain('내보낼 테이블을 고르세요');
    await button(w, 'RP 연구과제 전체').trigger('click');
    await flushPromises();
    expect(
      calls
        .filter((c) => c.path === `${P}/tables`)
        .at(-1)!
        .query.get('bizAreaId'),
    ).toBe('6');
    expect(w.get('[data-testid="selected-tables"]').text()).toContain('RP_C');
    w.unmount();
  });
});
