import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import type {
  BizAreaItem,
  DdlResponse,
  DefaultColSetItem,
  MemberRole,
  MyProject,
  ProjectSettings,
  TableColumnItem,
  TableDetail,
  TableHistoryItem,
} from '@termflow/shared';
import { api } from '../api/client.js';
import { draftKey, loadDraft } from '../editor/draft-storage.js';
import { createAppRouter } from '../router.js';
import { useSessionStore } from '../stores/session.js';
import { useToastStore } from '../stores/toast.js';
import { fakeFetch, json, problem, type FakeRequest, type Handler } from '../test-utils.js';
import TableEditorPage from './TableEditorPage.vue';

// T8.8~T8.14 편집기 화면: 키보드 10컬럼 입력·저장, 기본컬럼 제외, DDL 패널(S3 단일), 409 병합, 임시저장 복원, 역할별 읽기 전용, 이력 복원
const P = '/api/v1/projects/RMS';
const BIZ: BizAreaItem[] = [
  { bizAreaId: 6, bizCd: 'RP', bizNm: '연구과제', tablePrefix: 'RP_', sortNo: 1, useYn: true, description: null, tableCnt: 1, codeClsCnt: 0, locked: true, origin: null },
  { bizAreaId: 9, bizCd: 'PS', bizNm: '인사', tablePrefix: 'PS_', sortNo: 2, useYn: true, description: null, tableCnt: 0, codeClsCnt: 0, locked: false, origin: null },
];
const SETTINGS: ProjectSettings = {
  projectKey: 'RMS',
  projectNm: '연구관리시스템',
  description: null,
  kind: 'PROJECT',
  status: 'ACTIVE',
  defaultDialect: 'POSTGRESQL',
  includeDefaultCols: true,
  defaultColSetId: 1,
  defaultColSets: [],
  copiedFrom: null,
  createdAt: '2026-09-29T10:00:00',
  createdBy: 'admin',
};
const SET: DefaultColSetItem = {
  setId: 1,
  setNm: '기본',
  description: null,
  isDefault: true,
  colCnt: 2,
  columnRefCnt: 0,
  updatedBy: 'admin',
  updatedAt: '2026-09-29T10:00:00',
  columns: ['FIRS_REG_DTS', 'FINA_REG_DTS'].map((nm, i) => ({
    defaultColId: 100 + i,
    colSeq: i + 1,
    logicalNm: nm === 'FIRS_REG_DTS' ? '최초등록일시' : '최종등록일시',
    physicalNm: nm,
    isPk: false,
    dataType: 'TIMESTAMP' as const,
    dataLength: 0,
    dataScale: null,
    typeText: 'TIMESTAMP(0)',
    isNullable: true,
    defaultVal: 'CURRENT_TIMESTAMP',
    colComment: nm,
  })),
};
const col = (id: number, seq: number, nm: string, over: Partial<TableColumnItem> = {}): TableColumnItem => ({
  columnId: id,
  colSeq: seq,
  logicalNm: `${nm} 논리`,
  physicalNm: nm,
  isPk: false,
  dataType: 'VARCHAR',
  dataLength: 20,
  dataScale: null,
  isNullable: true,
  defaultVal: null,
  colComment: nm,
  domainId: null,
  codeClsId: null,
  defaultColId: null,
  matchType: 'MANUAL',
  domainNm: null,
  codeCls: null,
  ...over,
});
function detail(over: Partial<TableDetail['table']> = {}, columns?: TableColumnItem[]): TableDetail {
  return {
    table: {
      tableId: 17,
      projectKey: 'RMS',
      bizAreaId: 6,
      bizCd: 'RP',
      bizNm: '연구과제',
      tablePrefix: 'RP_',
      bizUseYn: true,
      tableNm: 'RP_TEST_MST',
      tableLogicalNm: '시험마스터',
      description: null,
      status: 'DRAFT',
      version: 3,
      finalizedAt: null,
      finalizedBy: null,
      reviewYn: false,
      reviewNote: null,
      createdBy: 'editor',
      createdAt: '2026-09-29T10:00:00',
      updatedBy: 'editor',
      updatedByNm: '편집자',
      updatedAt: '2026-09-29T12:30:05',
      ...over,
    },
    columns: columns ?? [
      col(1, 1, 'TEST_ID', { isPk: true, isNullable: false, matchType: 'EXACT', domainId: 5 }),
      col(2, 2, 'TEST_NM'),
      col(3, 3, 'FIRS_REG_DTS', { dataType: 'TIMESTAMP', dataLength: 0, defaultColId: 100, matchType: 'DEFAULT', defaultVal: 'CURRENT_TIMESTAMP' }),
      col(4, 4, 'FINA_REG_DTS', { dataType: 'TIMESTAMP', dataLength: 0, defaultColId: 101, matchType: 'DEFAULT', defaultVal: 'CURRENT_TIMESTAMP' }),
    ],
    errors: [],
    warnings: [],
  };
}
const ddlResp = (draft: { table: { tableNm: string }; columns: { physicalNm: string }[] }): DdlResponse => {
  const sql = `CREATE TABLE ${draft.table.tableNm} (\n${draft.columns.map((c) => `    ${c.physicalNm}                VARCHAR(20)`).join(',\n')}\n);\n`;
  return {
    dialect: 'POSTGRESQL',
    tableCnt: 1,
    sql,
    files: [],
    tables: [{ tableId: null, tableNm: draft.table.tableNm, logicalNm: '', bizCd: 'RP', status: null, version: null, colCnt: draft.columns.length, sql, warningCnt: 1 }],
    warnings: [{ code: 'W_PK_NONE', target: 'column', rowIndex: 1, columnNm: draft.columns[1]?.physicalNm, message: '경고 예시' }],
  };
};

async function setup(path: string, role: MemberRole, routes: Record<string, Handler>, sysAdmin = false) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const proj: MyProject = { key: 'RMS', nm: '연구관리시스템', role, kind: 'PROJECT', status: 'ACTIVE' };
  const f = fakeFetch({
    'GET /api/v1/auth/csrf': () => json(200, { token: 'T' }),
    'GET /api/v1/me': () =>
      json(200, { user: { id: 3, loginId: 'u', userNm: '사용자', isSysAdmin: sysAdmin }, mustChangePassword: false, projects: [proj] }),
    [`GET ${P}/biz-areas`]: () => json(200, BIZ),
    [`GET ${P}/settings`]: () => json(200, SETTINGS),
    [`GET ${P}/standards/default-column-sets`]: () => json(200, [SET]),
    [`POST ${P}/tables/validate`]: () => json(200, { errors: [], warnings: [] }),
    [`POST ${P}/ddl`]: (r) => json(200, ddlResp(JSON.parse(r.body!).draft)),
    ...routes,
  });
  vi.stubGlobal('fetch', f.fetch);
  api.setCsrfToken(null);
  const router = createAppRouter(createMemoryHistory());
  await useSessionStore().refresh();
  await router.push(path);
  await router.isReady();
  const w = mount(TableEditorPage, { global: { plugins: [pinia, router] }, attachTo: document.body });
  mounted.push(w);
  await until(() => !w.find('.skeleton').exists() && w.find('[data-testid="column-grid"]').exists());
  return { w, router, calls: f.calls };
}
const until = (cond: () => boolean, label = '') =>
  vi.waitFor(
    () => {
      if (!cond()) throw new Error(`조건 대기 ${label}`);
    },
    { timeout: 20_000, interval: 20 },
  );
const bodies = (calls: FakeRequest[], method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === path).map((c) => JSON.parse(c.body!));
const cell = (w: VueWrapper, row: number, field: string) =>
  w.get<HTMLInputElement>(`tbody tr[data-row="${row}"] [data-field="${field}"]`);
const button = (w: VueWrapper, text: string) => w.findAll('button').find((b) => b.text().includes(text))!;
const key = (target: Element, k: string, opts: KeyboardEventInit = {}) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));

/** 실패한 테스트가 남긴 화면(디바운스 타이머)이 다음 테스트의 fetch를 부르지 않게 전부 해제한다. */
const mounted: VueWrapper[] = [];
beforeEach(() => localStorage.clear());
afterEach(() => {
  for (const m of mounted.splice(0)) {
    try {
      m.unmount();
    } catch {
      /* 이미 해제됨 */
    }
  }
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('편집기 그리드·키보드(T8.8)', () => {
  it('키보드만으로 새 테이블 10컬럼 입력(Enter = 다음 행·새 행) → Ctrl+S → POST(10 + 기본컬럼 2) → v1 저장됨 → 편집기 경로로', async () => {
    const { w, router, calls } = await setup('/projects/RMS/tables/new?bizAreaId=9', 'EDITOR', {
      [`POST ${P}/tables`]: (r) => {
        const b = JSON.parse(r.body!) as { columns: unknown[] };
        return json(201, {
          tableId: 70,
          version: 1,
          status: 'DRAFT',
          columns: b.columns.map((_, i) => ({ columnId: 500 + i, colSeq: i + 1 })),
          changeSummary: `테이블 생성 · 컬럼 ${b.columns.length}`,
          warnings: [],
        });
      },
      [`GET ${P}/tables/70`]: () => json(200, detail({ tableId: 70, version: 1, tableNm: 'PS_KBD_MST', bizAreaId: 9, bizCd: 'PS' })),
    });
    await until(() => router.currentRoute.value.query['draft'] !== undefined);
    // 업무구분 PS 접두어로 시작
    expect(w.get<HTMLInputElement>('#ed-phys').element.value).toBe('PS_');
    await w.get('#ed-logical').setValue('키보드시험');
    await w.get('#ed-phys').setValue('PS_KBD_MST');
    for (let i = 1; i <= 10; i++) {
      await cell(w, i, 'logicalNm').setValue(`컬럼${i}`);
      await cell(w, i, 'physicalNm').setValue(`col_${i}`);
      await cell(w, i, 'typeText').setValue(i === 1 ? 'varchar(20)' : 'INT');
      if (i === 1) await cell(w, 1, 'isPk').setValue(true);
      key(cell(w, i, 'logicalNm').element, 'Enter');
      await until(() => w.find(`tbody tr[data-row="${i + 1}"]`).exists());
      expect(document.activeElement).toBe(cell(w, i + 1, 'logicalNm').element);
    }
    // 1행 PK → NULL 허용 비활성(NOT NULL 자동)
    expect(cell(w, 1, 'isNullable').element.disabled).toBe(true);
    key(document.body, 's', { ctrlKey: true });
    await until(() => bodies(calls, 'POST', `${P}/tables`).length === 1);
    const sent = bodies(calls, 'POST', `${P}/tables`)[0] as {
      table: { bizAreaId: number; tableNm: string };
      columns: { physicalNm: string; isPk: boolean; isNullable: boolean; dataType: string; defaultColId: number | null }[];
    };
    expect(sent.table).toMatchObject({ bizAreaId: 9, tableNm: 'PS_KBD_MST' });
    expect(sent.columns).toHaveLength(12); // 빈 11행(입력 대기)은 보내지 않음
    expect(sent.columns[0]).toMatchObject({ physicalNm: 'COL_1', isPk: true, isNullable: false, dataType: 'VARCHAR' });
    expect(sent.columns.slice(10).map((c) => c.defaultColId)).toEqual([100, 101]);
    await until(() => router.currentRoute.value.path === '/projects/RMS/tables/70');
    expect(useToastStore().items.map((t) => t.text)).toContain('v1 저장됨');
    w.unmount();
  });

  it('↑↓ 행 이동, Alt+↓ 행 순서 변경, 타입 형식 오류 → 빨간 테두리·저장 비활성, 서버 E → 해당 셀 invalid + 툴팁', async () => {
    const { w } = await setup('/projects/RMS/tables/17', 'EDITOR', {
      [`GET ${P}/tables/17`]: () => json(200, detail()),
      [`POST ${P}/tables/validate`]: () =>
        json(200, {
          errors: [{ code: 'E_PHYS_DUP', target: 'column', rowIndex: 1, field: 'physicalNm', message: '물리명 TEST_NM이(가) 1행과 중복됩니다' }],
          warnings: [],
        }),
    });
    const first = cell(w, 1, 'physicalNm').element;
    first.focus();
    key(first, 'ArrowDown');
    await flushPromises();
    expect(document.activeElement).toBe(cell(w, 2, 'physicalNm').element);
    key(cell(w, 1, 'logicalNm').element, 'ArrowDown', { altKey: true });
    await flushPromises();
    expect(cell(w, 1, 'physicalNm').element.value).toBe('TEST_NM');
    expect(cell(w, 2, 'physicalNm').element.value).toBe('TEST_ID');

    await cell(w, 1, 'typeText').setValue('VARCHR(20)');
    expect(cell(w, 1, 'typeText').classes()).toContain('is-invalid');
    expect(cell(w, 1, 'typeText').attributes('title')).toMatch(/알 수 없는 타입/);
    expect(w.get('[data-testid="save"]').attributes('disabled')).toBeDefined();
    expect(w.get('[data-testid="validation-bar"]').text()).toContain('오류');
    await cell(w, 1, 'typeText').setValue('VARCHAR(20)');
    // 디바운스 후 서버 검증 E(rowIndex 1 = 본문 2번째 행)
    await until(() => cell(w, 2, 'physicalNm').classes().includes('is-invalid'));
    expect(cell(w, 2, 'physicalNm').attributes('title')).toContain('중복');
    expect(w.get('tbody tr[data-row="2"] [data-state]').attributes('data-state')).toBe('invalid');
    w.unmount();
  });
});

describe('기본컬럼 영역·DDL 패널(T8.10·T8.11)', () => {
  it('기본컬럼 제외 → DDL 미리보기 본문과 저장 본문에서 빠짐, S3 단일: [DDL](1) → [복사](2) = 클립보드 + 기록 COPY', async () => {
    const writes: string[] = [];
    vi.stubGlobal('navigator', { clipboard: { writeText: (t: string) => (writes.push(t), Promise.resolve()) } });
    const { w, calls } = await setup('/projects/RMS/tables/17', 'EDITOR', {
      [`GET ${P}/tables/17`]: () => json(200, detail()),
      [`POST ${P}/export-logs`]: () => json(201, { exportId: 1 }),
      [`PUT ${P}/tables/17`]: (r) =>
        json(200, {
          tableId: 17,
          version: 4,
          status: 'DRAFT',
          columns: (JSON.parse(r.body!) as { columns: unknown[] }).columns.map((_, i) => ({ columnId: i + 1, colSeq: i + 1 })),
          changeSummary: '컬럼 +0 ~0 -1',
          warnings: [],
        }),
    });
    expect(w.get('[data-testid="default-cols"]').text()).toContain('기본컬럼 2개');
    // S3 단일: 패널이 닫힌 상태에서 [DDL] → [복사]
    if (w.find('[data-testid="ddl-panel"]').exists()) await w.get('[data-testid="toggle-ddl"]').trigger('click');
    let clicks = 0;
    await w.get('[data-testid="toggle-ddl"]').trigger('click');
    clicks++;
    await until(() => w.find('[data-testid="ddl-code"]').text().includes('CREATE TABLE RP_TEST_MST'));
    await button(w, '복사').trigger('click');
    clicks++;
    await until(() => bodies(calls, 'POST', `${P}/export-logs`).length === 1);
    expect(clicks).toBe(2);
    expect(writes[0]).toContain('CREATE TABLE RP_TEST_MST');
    expect(bodies(calls, 'POST', `${P}/export-logs`)[0]).toMatchObject({ kind: 'COPY', tableIds: [17] });
    // 경고 클릭 → 해당 행 포커스(rowIndex 1 = 2행)
    await w.get('[data-testid="ddl-panel-warnings"] button').trigger('click');
    await flushPromises();
    expect(document.activeElement).toBe(cell(w, 2, 'logicalNm').element);

    // 기본컬럼 FINA_REG_DTS 제외 → DDL 요청 본문에서 빠짐
    await w.get('input[aria-label="기본컬럼 FINA_REG_DTS 포함"]').setValue(false);
    await until(() => {
      const last = bodies(calls, 'POST', `${P}/ddl`).at(-1) as { draft: { columns: { physicalNm: string }[] } };
      return !last.draft.columns.some((c) => c.physicalNm === 'FINA_REG_DTS');
    });
    await until(() => !w.get('[data-testid="ddl-code"]').text().includes('FINA_REG_DTS'));
    // 복사 기록은 저장본과 같을 때만(저장 전 편집본 복사는 기록 생략, CR-06 §5)
    await button(w, '복사').trigger('click');
    await flushPromises();
    expect(bodies(calls, 'POST', `${P}/export-logs`)).toHaveLength(1);
    await w.get('[data-testid="save"]').trigger('click');
    await until(() => bodies(calls, 'PUT', `${P}/tables/17`).length === 1);
    const put = bodies(calls, 'PUT', `${P}/tables/17`)[0] as { version: number; columns: { physicalNm: string }[] };
    expect(put.version).toBe(3);
    expect(put.columns.map((c) => c.physicalNm)).toEqual(['TEST_ID', 'TEST_NM', 'FIRS_REG_DTS']);
    w.unmount();
  });
});

describe('저장 충돌(T8.12)·임시저장(T8.13)', () => {
  it('409 → 충돌 병합 모달(최신본 ↔ 내 편집본 나란히) → 확인 체크 후 덮어쓰기 = currentVersion으로 재전송', async () => {
    let puts = 0;
    const current = detail({ version: 4, updatedByNm: '김민수', updatedAt: '2026-09-29T12:31:00' }, [
      ...detail().columns.slice(0, 2),
      col(9, 3, 'THEIR_ONLY'),
    ]);
    const { w, calls } = await setup('/projects/RMS/tables/17', 'EDITOR', {
      [`GET ${P}/tables/17`]: () => json(200, puts > 1 ? detail({ version: 5 }) : detail()),
      [`PUT ${P}/tables/17`]: (r) => {
        puts++;
        const b = JSON.parse(r.body!) as { version: number; columns: unknown[] };
        if (b.version === 3)
          return problem(409, 'version-conflict', 'E_VERSION_CONFLICT', {
            detail: '김민수이(가) 12:31:00에 저장했습니다.',
            yourVersion: 3,
            currentVersion: 4,
            savedBy: '김민수',
            savedAt: '2026-09-29T12:31:00',
            current: { table: current.table, columns: current.columns },
          });
        return json(200, { tableId: 17, version: 5, status: 'DRAFT', columns: b.columns.map((_, i) => ({ columnId: i + 1, colSeq: i + 1 })), changeSummary: '', warnings: [] });
      },
    });
    await cell(w, 2, 'colComment').setValue('내 변경');
    key(document.body, 's', { ctrlKey: true });
    await until(() => w.find('[aria-modal="true"]').exists());
    const modal = w.get('[aria-modal="true"]');
    expect(modal.text()).toContain('김민수');
    expect(modal.text()).toContain('(v4)');
    expect(modal.text()).toContain('THEIR_ONLY');
    expect(modal.get('[data-testid="compare-summary"]').text()).toMatch(/차이 \d+건/);
    // 편집본은 이미 임시저장(아무것도 잃지 않음)
    expect(loadDraft(draftKey('RMS', 17))?.columns.find((c) => c.physicalNm === 'TEST_NM')?.colComment).toBe('내 변경');
    const over = button(w, '내 편집본으로 덮어쓰기');
    expect(over.attributes('disabled')).toBeDefined();
    await modal.get('input[type="checkbox"]').setValue(true);
    await over.trigger('click');
    await until(() => bodies(calls, 'PUT', `${P}/tables/17`).length === 2);
    expect(bodies(calls, 'PUT', `${P}/tables/17`)[1]).toMatchObject({ version: 4 });
    await until(() => !w.find('[aria-modal="true"]').exists());
    expect(useToastStore().items.map((t) => t.text)).toContain('v5 저장됨');
    expect(loadDraft(draftKey('RMS', 17))).toBeNull();
    w.unmount();
  });

  it('409 → [최신본 새로고침]: 편집기를 current로 교체(재조회 없음), 내 편집본은 임시저장에 남는다', async () => {
    const current = detail({ version: 4 }, [col(1, 1, 'TEST_ID', { isPk: true, isNullable: false }), col(9, 2, 'THEIR_ONLY')]);
    const { w, calls } = await setup('/projects/RMS/tables/17', 'EDITOR', {
      [`GET ${P}/tables/17`]: () => json(200, detail()),
      [`PUT ${P}/tables/17`]: () =>
        problem(409, 'version-conflict', 'E_VERSION_CONFLICT', {
          yourVersion: 3,
          currentVersion: 4,
          savedBy: '김민수',
          savedAt: '2026-09-29T12:31:00',
          current: { table: current.table, columns: current.columns },
        }),
    });
    await cell(w, 2, 'colComment').setValue('내 변경');
    await w.get('[data-testid="save"]').trigger('click');
    await until(() => w.find('[aria-modal="true"]').exists());
    const gets = calls.filter((c) => c.path === `${P}/tables/17` && c.method === 'GET').length;
    await button(w, '최신본 새로고침').trigger('click');
    await until(() => !w.find('[aria-modal="true"]').exists());
    expect(calls.filter((c) => c.path === `${P}/tables/17` && c.method === 'GET').length).toBe(gets);
    expect(cell(w, 2, 'physicalNm').element.value).toBe('THEIR_ONLY');
    expect(w.get('[data-testid="editor-status"]').text()).toContain('v4');
    expect(loadDraft(draftKey('RMS', 17))).not.toBeNull();
    expect(w.find('[data-testid="draft-banner"]').exists()).toBe(true); // 임시저장본 ≠ 현재 → 복원 안내
    w.unmount();
  });

  it('세션 만료(401) → 즉시 임시저장 → 재로그인 후 재진입 → 복원 배너("그 사이 다른 저장") → [복원]', async () => {
    const first = await setup('/projects/RMS/tables/17', 'EDITOR', {
      [`GET ${P}/tables/17`]: () => json(200, detail()),
      [`PUT ${P}/tables/17`]: () => problem(401, 'unauthorized', 'E_UNAUTHORIZED'),
    });
    await cell(first.w, 2, 'logicalNm').setValue('만료 전 편집');
    await first.w.get('[data-testid="save"]').trigger('click');
    await until(() => loadDraft(draftKey('RMS', 17)) !== null);
    expect(loadDraft(draftKey('RMS', 17))).toMatchObject({ baseVersion: 3 });
    first.w.unmount();

    // 재로그인 후 다시 열기: 그 사이 다른 사용자가 v4로 저장
    const again = await setup('/projects/RMS/tables/17', 'EDITOR', {
      [`GET ${P}/tables/17`]: () => json(200, detail({ version: 4 })),
    });
    const banner = again.w.get('[data-testid="draft-banner"]');
    expect(banner.text()).toContain('저장되지 않은 편집본');
    expect(banner.text()).toContain('그 사이 다른 저장이 있었습니다');
    expect(cell(again.w, 2, 'logicalNm').element.value).toBe('TEST_NM 논리');
    await button(again.w, '복원').trigger('click');
    await flushPromises();
    expect(cell(again.w, 2, 'logicalNm').element.value).toBe('만료 전 편집');
    expect(again.w.find('[data-testid="draft-banner"]').exists()).toBe(false);
    again.w.unmount();
  });
});

describe('역할·상태별 화면(T8.9)', () => {
  it('조회자: 읽기 전용(저장 버튼 없음·입력 readonly·배너), DDL 패널은 사용 가능', async () => {
    const { w, calls } = await setup('/projects/RMS/tables/17', 'VIEWER', {
      [`GET ${P}/tables/17`]: () => json(200, detail()),
    });
    expect(w.find('[data-testid="save"]').exists()).toBe(false);
    expect(w.find('[data-testid="readonly-banner"]').exists()).toBe(true);
    expect(cell(w, 1, 'logicalNm').attributes('readonly')).toBeDefined();
    expect(w.get<HTMLSelectElement>('#ed-biz').element.disabled).toBe(true);
    if (!w.find('[data-testid="ddl-panel"]').exists()) await w.get('[data-testid="toggle-ddl"]').trigger('click');
    await until(() => bodies(calls, 'POST', `${P}/ddl`).length > 0);
    expect(calls.some((c) => c.path === `${P}/tables/validate`)).toBe(false);
    w.unmount();
  });

  it('FINAL: 편집자는 배너만(해제 없음), 프로젝트 관리자는 [확정 해제] → PUT status DRAFT(사유)', async () => {
    const fin = detail({ status: 'FINAL', finalizedBy: 'editor', finalizedAt: '2026-09-29T13:00:00' });
    const ed = await setup('/projects/RMS/tables/17', 'EDITOR', { [`GET ${P}/tables/17`]: () => json(200, fin) });
    expect(ed.w.get('[data-testid="final-banner"]').text()).toContain('프로젝트 관리자에게');
    expect(ed.w.find('[data-testid="save"]').exists()).toBe(false);
    expect(button(ed.w, '확정 해제')).toBeUndefined();
    ed.w.unmount();

    let status = 'FINAL';
    const pa = await setup('/projects/RMS/tables/17', 'ADMIN', {
      [`GET ${P}/tables/17`]: () => json(200, status === 'FINAL' ? fin : detail({ version: 5 })),
      [`PUT ${P}/tables/17/status`]: () => {
        status = 'DRAFT';
        return json(200, { tableId: 17, version: 5, status: 'DRAFT', finalizedAt: null, finalizedBy: null });
      },
    });
    await pa.w.get('input[aria-label="확정 해제 사유"]').setValue('컬럼 추가');
    await button(pa.w, '확정 해제').trigger('click');
    await until(() => bodies(pa.calls, 'PUT', `${P}/tables/17/status`).length === 1);
    expect(bodies(pa.calls, 'PUT', `${P}/tables/17/status`)[0]).toEqual({ status: 'DRAFT', version: 3, note: '컬럼 추가' });
    await until(() => pa.w.find('[data-testid="save"]').exists());
    pa.w.unmount();
  });

  it('DRAFT → [FINAL로 확정](상태 배지 메뉴) → PUT status FINAL → 편집 차단 배너', async () => {
    let status = 'DRAFT';
    const { w, calls } = await setup('/projects/RMS/tables/17', 'EDITOR', {
      [`GET ${P}/tables/17`]: () => json(200, status === 'DRAFT' ? detail() : detail({ status: 'FINAL', version: 4, finalizedBy: 'u' })),
      [`PUT ${P}/tables/17/status`]: () => {
        status = 'FINAL';
        return json(200, { tableId: 17, version: 4, status: 'FINAL', finalizedAt: '2026-09-29T13:00:00', finalizedBy: 'u' });
      },
    });
    await w.get('[data-testid="status-badge"]').trigger('click');
    await button(w, 'FINAL로 확정').trigger('click');
    await until(() => w.find('[data-testid="final-banner"]').exists());
    expect(bodies(calls, 'PUT', `${P}/tables/17/status`)[0]).toMatchObject({ status: 'FINAL', version: 3 });
    expect(cell(w, 1, 'logicalNm').attributes('readonly')).toBeDefined();
    w.unmount();
  });
});

describe('이력 패널(T8.14)', () => {
  it('[이력] → 목록 → 비교(과거 ↔ 현재 나란히) → 복원 확인(인라인) → POST restore(현재 version)', async () => {
    const hist: TableHistoryItem[] = [3, 2, 1].map((v) => ({
      version: v,
      action: v === 1 ? 'CREATE' : 'UPDATE',
      changeSummary: v === 1 ? '테이블 생성 · 컬럼 2' : '컬럼 +1 ~0 -0',
      savedBy: 'editor',
      savedByNm: '편집자',
      savedAt: '2026-09-29T12:00:00',
    }));
    const { w, calls } = await setup('/projects/RMS/tables/17', 'EDITOR', {
      [`GET ${P}/tables/17`]: () => json(200, detail()),
      [`GET ${P}/tables/17/history`]: () => json(200, hist),
      [`GET ${P}/tables/17/history/1`]: () =>
        json(200, {
          ...hist[2],
          snapshot: { schemaVersion: 1, table: {}, columns: [col(1, 1, 'TEST_ID'), col(8, 2, 'OLD_ONLY')], action: 'CREATE', changeSummary: '', savedBy: 'editor', savedAt: '' },
        }),
      [`POST ${P}/tables/17/history/1/restore`]: () =>
        json(200, { tableId: 17, version: 4, status: 'DRAFT', columns: [], changeSummary: 'v1 복원', warnings: [] }),
    });
    await button(w, '이력').trigger('click');
    await until(() => w.find('[data-testid="history-panel"]').exists(), '패널');
    await until(() => w.find('[data-testid="history-panel"] .list-item').exists(), '목록');
    const panel = w.get('[data-testid="history-panel"]');
    expect(panel.findAll('.list-item')).toHaveLength(3);
    // v3 = 현재(비교 없음), v2·v1에 [비교] → v1 선택
    const cmp = panel.findAll('button').filter((b) => b.text() === '비교');
    expect(cmp).toHaveLength(2);
    await cmp[1]!.trigger('click');
    await until(() => w.find('[data-testid="history-panel"] [data-testid="column-compare"]').exists(), '비교');
    expect(w.get('[data-testid="history-panel"]').text()).toContain('OLD_ONLY');
    await button(w, 'v1(으)로 복원').trigger('click');
    await w.get('[data-testid="confirm-restore"]').trigger('click');
    await until(() => bodies(calls, 'POST', `${P}/tables/17/history/1/restore`).length === 1, '복원');
    expect(bodies(calls, 'POST', `${P}/tables/17/history/1/restore`)[0]).toEqual({ version: 3 });
    expect(w.findAll('[role="dialog"][aria-modal="true"]')).toHaveLength(0); // 모달 아님(G9)
    w.unmount();
  });
});
