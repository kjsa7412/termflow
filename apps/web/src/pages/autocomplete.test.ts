import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import type {
  AutocompleteApplied,
  AutocompleteCandidate,
  AutocompleteResponse,
  AutocompleteSegment,
  BizAreaItem,
  DefaultColSetItem,
  MyProject,
  ProjectSettings,
  TableColumnItem,
  TableDetail,
} from '@termflow/shared';
import { api } from '../api/client.js';
import { createAppRouter } from '../router.js';
import { useSessionStore } from '../stores/session.js';
import { fakeFetch, json, type FakeRequest, type Handler } from '../test-utils.js';
import TableEditorPage from './TableEditorPage.vue';

/**
 * 단계 9 편집기 자동완성 화면 테스트(T9.5·T9.7·T9.8·T9.9, 설계서 §10.4, 검토안 4.3 계수 규칙).
 * 계수: 입력 = 값을 타이핑한 필드 수, 클릭 = 마우스 클릭(키보드 선택은 0), 이동 = 페이지·모달 전환.
 *  - S2·G1: 10컬럼(exact 8·similar 1·composed 1) → 저장 → DDL 복사
 *  - S4·G2: 미등록 1건 인라인 등록 → 자동 재시도 · S6: 코드구분 후보 선택
 */
const P = '/api/v1/projects/RMS';
const BIZ: BizAreaItem[] = [
  {
    bizAreaId: 6,
    bizCd: 'RP',
    bizNm: '연구과제',
    tablePrefix: 'RP_',
    sortNo: 1,
    useYn: true,
    description: null,
    tableCnt: 1,
    codeClsCnt: 0,
    locked: true,
    origin: null,
  },
  {
    bizAreaId: 9,
    bizCd: 'PS',
    bizNm: '인사',
    tablePrefix: 'PS_',
    sortNo: 2,
    useYn: true,
    description: null,
    tableCnt: 0,
    codeClsCnt: 0,
    locked: false,
    origin: null,
  },
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
    logicalNm: nm,
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

const applied = (physicalNm: string, over: Partial<AutocompleteApplied> = {}) => ({
  physicalNm,
  dataType: 'VARCHAR' as const,
  dataLength: 20,
  dataScale: null,
  typeText: 'VARCHAR(20)',
  colComment: '',
  domainId: null,
  matchType: 'EXACT' as const,
  ...over,
});
const resp = (logicalNm: string, over: Partial<AutocompleteResponse>): AutocompleteResponse => ({
  type: 'exact',
  input: logicalNm,
  normalized: logicalNm,
  applied: null,
  warnings: [],
  cacheVersion: 3,
  elapsedMs: 1,
  ...over,
});
const seg = (kor: string, physical: string | null, status?: 'PENDING'): AutocompleteSegment =>
  physical === null
    ? { kor, physical: null, matched: false }
    : { kor, physical, matched: true, ...(status ? { status } : {}) };
const domainCand = (
  logicalNm: string,
  physicalNm: string,
  domainId: number,
): AutocompleteCandidate => ({
  kind: 'domain',
  domainId,
  logicalNm,
  physicalNm,
  dataType: 'VARCHAR',
  dataLength: 8,
  dataScale: null,
  typeText: 'VARCHAR(8)',
  colComment: logicalNm,
  score: 150,
});

/** S2 10컬럼(실데이터 autocomplete-rms 테스트와 같은 논리명). */
const EXACT: [string, string][] = [
  ['전자결재번호', 'ELC_APV_NO'],
  ['요청일자', 'REQ_DT'],
  ['심의일자', 'INSP_DT'],
  ['사용여부', 'USE_YN'],
  ['삭제여부', 'DEL_YN'],
  ['정렬순서', 'SORT_ORD'],
  ['첨부파일ID', 'ATTCH_FILE_ID'],
  ['비용금액', 'COST_AMT'],
];
const AC: Record<string, AutocompleteResponse> = {
  ...Object.fromEntries(
    EXACT.map(([nm, ph], i) => [
      nm,
      resp(nm, {
        type: 'exact',
        applied: applied(ph, { colComment: nm, domainId: 900 + i }),
      }),
    ]),
  ),
  접수일: resp('접수일', {
    type: 'similar',
    segments: [seg('접수', 'RCPT'), seg('일', 'DD')],
    candidates: [
      domainCand('접수일시', 'RCPT_DTS', 801),
      domainCand('접수일자', 'RCPT_DT', 802),
      {
        kind: 'composed',
        logicalNm: '접수일',
        physicalNm: 'RCPT_DD',
        dataType: null,
        dataLength: null,
        dataScale: null,
        typeText: null,
        colComment: '접수일',
        score: 0,
        segments: [seg('접수', 'RCPT'), seg('일', 'DD')],
      },
    ],
  }),
  과제관리번호: resp('과제관리번호', {
    type: 'composed',
    applied: applied('PRJ_MNGT_NO', { matchType: 'COMPOSED', colComment: '과제관리번호' }),
    segments: [seg('과제', 'PRJ'), seg('관리', 'MNGT'), seg('번호', 'NO')],
  }),
  연구과제상태코드: resp('연구과제상태코드', {
    type: 'composed',
    applied: applied('RSCH_PRJ_STAT_CD', {
      matchType: 'COMPOSED',
      typeText: 'VARCHAR(10)',
      dataLength: 10,
      colComment: '연구과제상태코드',
    }),
    segments: [seg('연구', 'RSCH'), seg('과제', 'PRJ'), seg('상태', 'STAT'), seg('코드', 'CD')],
    codeCandidates: [
      {
        codeClsId: 41,
        bizCd: 'PS',
        bizNm: '인사',
        codeCls: '023',
        codeClsNm: '상태',
        logicalNm: '연구과제상태코드',
        physicalNm: 'RSCH_PRJ_STAT_CD',
        dataType: 'VARCHAR',
        dataLength: 10,
        dataScale: null,
        typeText: 'VARCHAR(10)',
        colComment: '연구과제상태코드(PS/023 상태)',
        domainId: null,
        codeCnt: 3,
        codes: [{ code: '01', codeNm: '재직' }],
        score: 60,
      },
    ],
  }),
};
/** S4: 등록 전 unregistered → 등록 후 composed(책임자 PENDING). */
let registered = false;
const S4_BEFORE = resp('연구책임자구분', {
  type: 'unregistered',
  applied: applied('RSCH_RSPN_?_TP', {
    matchType: 'UNREGISTERED',
    typeText: 'VARCHAR(10)',
    dataLength: 10,
  }),
  segments: [seg('연구', 'RSCH'), seg('책임', 'RSPN'), seg('자', null), seg('구분', 'TP')],
  registerCandidates: ['책임자', '자'],
  warnings: [
    { code: 'W_TERM_UNREGISTERED', target: 'column', message: '미등록 용어가 남아 있습니다' },
  ],
});
const S4_AFTER = resp('연구책임자구분', {
  type: 'composed',
  applied: applied('RSCH_RESP_TP', {
    matchType: 'COMPOSED',
    typeText: 'VARCHAR(10)',
    dataLength: 10,
    colComment: '연구책임자구분',
  }),
  segments: [seg('연구', 'RSCH'), seg('책임자', 'RESP', 'PENDING'), seg('구분', 'TP')],
  warnings: [{ code: 'W_TERM_PENDING', target: 'column', message: "검토대기 용어 '책임자' 사용" }],
  cacheVersion: 4,
});

const acHandler: Handler = async (r) => {
  const b = JSON.parse(r.body!) as { logicalNm: string };
  if (b.logicalNm === '연구책임자구분') return json(200, registered ? S4_AFTER : S4_BEFORE);
  const hit = AC[b.logicalNm];
  return hit
    ? json(200, hit)
    : json(200, resp(b.logicalNm, { type: 'exact', applied: applied('X') }));
};

const mounted: VueWrapper[] = [];
async function setup(path: string, routes: Record<string, Handler> = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const proj: MyProject = {
    key: 'RMS',
    nm: '연구관리시스템',
    role: 'EDITOR',
    kind: 'PROJECT',
    status: 'ACTIVE',
  };
  const f = fakeFetch({
    'GET /api/v1/auth/csrf': () => json(200, { token: 'T' }),
    'GET /api/v1/me': () =>
      json(200, {
        user: { id: 3, loginId: 'u', userNm: '사용자', isSysAdmin: false },
        mustChangePassword: false,
        projects: [proj],
      }),
    [`GET ${P}/biz-areas`]: () => json(200, BIZ),
    [`GET ${P}/settings`]: () => json(200, SETTINGS),
    [`GET ${P}/standards/default-column-sets`]: () => json(200, [SET]),
    [`POST ${P}/tables/validate`]: () => json(200, { errors: [], warnings: [] }),
    [`POST ${P}/ddl`]: (r) => {
      const d = JSON.parse(r.body!) as {
        draft?: { table: { tableNm: string }; columns: { physicalNm: string }[] };
      };
      const sql = `CREATE TABLE ${d.draft?.table.tableNm ?? 'X'} (\n${(d.draft?.columns ?? []).map((c) => `  ${c.physicalNm}`).join(',\n')}\n);\n`;
      return json(200, {
        dialect: 'POSTGRESQL',
        tableCnt: 1,
        sql,
        files: [],
        tables: [],
        warnings: [],
      });
    },
    [`POST ${P}/autocomplete/columns`]: acHandler,
    [`POST ${P}/tables/suggest-name`]: (r) => {
      const b = JSON.parse(r.body!) as { logicalNm: string; bizAreaId: number };
      const prefix = BIZ.find((x) => x.bizAreaId === b.bizAreaId)?.tablePrefix ?? '';
      return json(200, {
        tableNm: `${prefix}PRJ_RCPT_HST`,
        prefix,
        segments: [seg('과제', 'PRJ'), seg('접수', 'RCPT'), seg('이력', 'HST')],
        complete: true,
        errors: [],
        warnings: [],
        cacheVersion: 3,
      });
    },
    ...routes,
  });
  vi.stubGlobal('fetch', f.fetch);
  api.setCsrfToken(null);
  const router = createAppRouter(createMemoryHistory());
  await useSessionStore().refresh();
  await router.push(path);
  await router.isReady();
  const w = mount(TableEditorPage, {
    global: { plugins: [pinia, router] },
    attachTo: document.body,
  });
  mounted.push(w);
  await until(
    () => !w.find('.skeleton').exists() && w.find('[data-testid="column-grid"]').exists(),
  );
  if (path.includes('/new'))
    await until(() => router.currentRoute.value.query['draft'] !== undefined);
  await until(
    () => w.find('[data-testid="column-grid"]').exists() && !w.find('.skeleton').exists(),
  );
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
const key = (target: Element, k: string, opts: KeyboardEventInit = {}) =>
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }),
  );
const button = (w: VueWrapper, text: string) =>
  w.findAll('button').find((b) => b.text().includes(text))!;

/** 검토안 4.3 계수기: 입력(필드 타이핑)·클릭(마우스)만 센다. 키보드 Enter·↑↓는 0. */
function counter() {
  const c = { input: 0, click: 0, move: 0 };
  return {
    c,
    type: async (el: ReturnType<VueWrapper['get']>, v: string) => {
      c.input++;
      await el.setValue(v);
    },
    click: async (el: { trigger: (e: string) => Promise<void> }) => {
      c.click++;
      await el.trigger('click');
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  registered = false;
});
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

describe('S2·G1 — 10컬럼(exact 8·similar 1·composed 1) → 저장 → DDL 복사', () => {
  it('입력 11 · 클릭 3(+목록의 [새 테이블] 1 = 4) · 이동 0(+편집기 진입 1 = 1) — 목표 입력 ≤12 · 클릭 ≤6 · 이동 ≤1', async () => {
    const writes: string[] = [];
    vi.stubGlobal('navigator', {
      clipboard: { writeText: (t: string) => (writes.push(t), Promise.resolve()) },
    });
    const savedCols: TableColumnItem[] = [];
    const { w, router, calls } = await setup('/projects/RMS/tables/new?bizAreaId=6', {
      [`POST ${P}/tables`]: (r) => {
        const b = JSON.parse(r.body!) as { columns: TableColumnItem[] };
        savedCols.push(
          ...b.columns.map((c, i) => ({
            ...c,
            columnId: 500 + i,
            colSeq: i + 1,
            domainNm: null,
            codeCls: null,
          })),
        );
        return json(201, {
          tableId: 70,
          version: 1,
          status: 'DRAFT',
          columns: b.columns.map((_, i) => ({ columnId: 500 + i, colSeq: i + 1 })),
          changeSummary: `테이블 생성 · 컬럼 ${b.columns.length}`,
          warnings: [],
        });
      },
      [`GET ${P}/tables/70`]: () =>
        json(200, {
          table: {
            tableId: 70,
            projectKey: 'RMS',
            bizAreaId: 6,
            bizCd: 'RP',
            bizNm: '연구과제',
            tablePrefix: 'RP_',
            bizUseYn: true,
            tableNm: 'RP_PRJ_RCPT_HST',
            tableLogicalNm: '과제접수이력',
            description: null,
            status: 'DRAFT',
            version: 1,
            finalizedAt: null,
            finalizedBy: null,
            reviewYn: false,
            reviewNote: null,
            createdBy: 'u',
            createdAt: '2026-09-30T10:00:00',
            updatedBy: 'u',
            updatedByNm: '사용자',
            updatedAt: '2026-09-30T10:00:00',
          },
          columns: savedCols,
          errors: [],
          warnings: [],
        } satisfies TableDetail),
      [`POST ${P}/export-logs`]: () => json(201, { exportId: 1 }),
    });
    const n = counter();
    // 논리 테이블명(입력 1) → blur/Enter → 물리명 자동 제안(업무구분 접두어 + 분절)
    await n.type(w.get('#ed-logical'), '과제접수이력');
    await w.get('#ed-logical').trigger('change');
    await until(() => w.get<HTMLInputElement>('#ed-phys').element.value === 'RP_PRJ_RCPT_HST');
    expect(w.get('[data-testid="pieces"]').text()).toContain('접수');

    const names = [...EXACT.map(([nm]) => nm), '접수일', '과제관리번호'];
    for (let i = 1; i <= names.length; i++) {
      await n.type(cell(w, i, 'logicalNm'), names[i - 1]!);
      key(cell(w, i, 'logicalNm').element, 'Enter');
      if (names[i - 1] === '접수일') {
        // similar: 인라인 listbox(도메인 2 + 조합) — ↓ Enter로 '접수일자' 선택(키보드 = 클릭 0)
        await until(() => w.find('[data-testid="ac-listbox"]').exists());
        expect(w.findAll('[role="option"]')).toHaveLength(3);
        expect(document.activeElement).toBe(cell(w, i, 'logicalNm').element);
        key(cell(w, i, 'logicalNm').element, 'ArrowDown');
        await until(() => w.findAll('[role="option"]')[1]!.attributes('aria-selected') === 'true');
        key(cell(w, i, 'logicalNm').element, 'Enter');
      }
      await until(() => w.find(`tbody tr[data-row="${i + 1}"]`).exists(), `행 ${i + 1}`);
      await until(
        () => document.activeElement === cell(w, i + 1, 'logicalNm').element,
        `포커스 ${i + 1}`,
      );
    }
    // PK(클릭 1)
    await n.click(cell(w, 1, 'isPk'));
    await cell(w, 1, 'isPk').setValue(true);
    const states = w.findAll('tbody tr[data-row]').map((tr) => tr.attributes('data-state'));
    expect(states.slice(0, 10)).toEqual([...Array(8).fill('exact'), 'exact', 'composed']);
    expect(cell(w, 9, 'logicalNm').element.value).toBe('접수일자');
    expect(cell(w, 10, 'physicalNm').element.value).toBe('PRJ_MNGT_NO');
    expect(w.find('tr.sub-row').text()).toContain('분절 조합');

    // 저장(클릭 2)
    await until(() => !w.get('[data-testid="save"]').attributes('disabled'));
    await n.click(w.get('[data-testid="save"]'));
    await until(() => bodies(calls, 'POST', `${P}/tables`).length === 1);
    const sent = bodies(calls, 'POST', `${P}/tables`)[0] as {
      table: { tableNm: string };
      columns: { physicalNm: string; matchType: string; domainId: number | null; isPk: boolean }[];
    };
    expect(sent.table.tableNm).toBe('RP_PRJ_RCPT_HST');
    expect(sent.columns.map((c) => c.matchType)).toEqual([
      ...Array(8).fill('EXACT'),
      'SIMILAR',
      'COMPOSED',
      'DEFAULT',
      'DEFAULT',
    ]);
    expect(sent.columns.slice(0, 10).map((c) => c.physicalNm)).toEqual([
      ...EXACT.map(([, ph]) => ph),
      'RCPT_DT',
      'PRJ_MNGT_NO',
    ]);
    expect(sent.columns[0]!.isPk).toBe(true);
    expect(sent.columns[8]!.domainId).toBe(802);
    await until(() => router.currentRoute.value.path === '/projects/RMS/tables/70');
    // DDL 패널은 기본 열림 → [복사](클릭 3) = 클립보드 + 기록 COPY(저장본)
    await until(() =>
      w.find('[data-testid="ddl-code"]').text().includes('CREATE TABLE RP_PRJ_RCPT_HST'),
    );
    await until(() => !button(w, '복사').attributes('disabled'));
    await n.click(button(w, '복사'));
    await until(() => bodies(calls, 'POST', `${P}/export-logs`).length === 1);
    expect(writes[0]).toContain('RCPT_DT');
    expect(bodies(calls, 'POST', `${P}/autocomplete/columns`)).toHaveLength(10);
    // 편집기 안 계수: 입력 11 · 클릭 3 · 이동 0. 테이블 목록 [새 테이블](클릭 1, 이동 1)을 더하면 G1 = 11 / 4 / 1
    expect(n.c).toEqual({ input: 11, click: 3, move: 0 });
    expect(n.c.input).toBeLessThanOrEqual(12);
    expect(n.c.click + 1).toBeLessThanOrEqual(6);
  });
});

describe('S4·G2 — 미등록 1건 인라인 등록 → 자동 재시도', () => {
  it('연구책임자구분 Enter → 조각(책임 ✓ 자 ✗) + 등록 카드(한글 용어 책임자) → 물리약어 입력(1) → Enter → PENDING 등록 → 재시도 RSCH_RESP_TP → 다음 행: 입력 1 · 클릭 0 · 이동 0', async () => {
    const { w, router, calls } = await setup('/projects/RMS/tables/new?bizAreaId=6', {
      [`POST ${P}/standards/terms/inline`]: () => {
        registered = true;
        return json(201, {
          termId: 1801,
          status: 'PENDING',
          outcome: 'CREATED',
          termKor: '책임자',
          termPhysical: 'RESP',
          conflicts: [],
          warnings: [],
        });
      },
    });
    const path0 = router.currentRoute.value.fullPath;
    await cell(w, 1, 'logicalNm').setValue('연구책임자구분'); // 시나리오 전제 입력(G2 계수 밖)
    key(cell(w, 1, 'logicalNm').element, 'Enter');
    await until(() => w.find('[data-testid="reg-card"]').exists());
    expect(w.find('tr.sub-row').text()).toContain('자 · 미등록');
    expect(cell(w, 1, 'physicalNm').element.value).toBe('RSCH_RSPN_?_TP');
    expect(w.get<HTMLInputElement>('[data-testid="reg-card"] input[readonly]').element.value).toBe(
      '책임자',
    );
    const phys = w.get<HTMLInputElement>('[data-testid="reg-physical"]');
    await until(() => document.activeElement === phys.element);
    const n = counter();
    await n.type(phys, 'resp'); // 소문자도 대문자로
    expect(phys.element.value).toBe('RESP');
    key(phys.element, 'Enter');
    await until(() => bodies(calls, 'POST', `${P}/standards/terms/inline`).length === 1);
    expect(bodies(calls, 'POST', `${P}/standards/terms/inline`)[0]).toEqual({
      termKor: '책임자',
      termPhysical: 'RESP',
      description: null,
    });
    await until(() => cell(w, 1, 'physicalNm').element.value === 'RSCH_RESP_TP');
    expect(w.find('[data-testid="reg-card"]').exists()).toBe(false);
    expect(w.get('tbody tr[data-row="1"]').attributes('data-state')).toBe('composed');
    expect(cell(w, 1, 'typeText').element.value).toBe('VARCHAR(10)');
    expect(w.find('tr.sub-row').text()).toContain('검토대기');
    await until(() => document.activeElement === cell(w, 2, 'logicalNm').element);
    expect(bodies(calls, 'POST', `${P}/autocomplete/columns`)).toHaveLength(2);
    expect(router.currentRoute.value.fullPath).toBe(path0);
    expect(n.c).toEqual({ input: 1, click: 0, move: 0 });
  });

  it('Esc = 카드 닫고 수동 입력(미등록 유지), 같은 논리명 Enter는 다음 행', async () => {
    const { w } = await setup('/projects/RMS/tables/new?bizAreaId=6');
    await cell(w, 1, 'logicalNm').setValue('연구책임자구분');
    key(cell(w, 1, 'logicalNm').element, 'Enter');
    await until(() => w.find('[data-testid="reg-card"]').exists());
    key(w.get('[data-testid="reg-physical"]').element, 'Escape');
    await until(() => !w.find('[data-testid="reg-card"]').exists());
    await until(() => document.activeElement === cell(w, 1, 'physicalNm').element);
    await cell(w, 1, 'physicalNm').setValue('RSCH_RSPN_TP');
    expect(w.get('tbody tr[data-row="1"]').attributes('data-state')).toBe('unregistered');
    key(cell(w, 1, 'logicalNm').element, 'Enter');
    await until(() => document.activeElement === cell(w, 2, 'logicalNm').element);
  });
});

describe('S6 — 코드성 컬럼 코드구분 후보 선택', () => {
  it('연구과제상태코드 Enter → 코드구분 후보 listbox → Enter = code_cls_id·코멘트 설정(입력 1 · 클릭 0 · 이동 0) → 저장 본문', async () => {
    const { w, calls } = await setup('/projects/RMS/tables/new?bizAreaId=6', {
      [`POST ${P}/tables`]: () =>
        json(201, {
          tableId: 71,
          version: 1,
          status: 'DRAFT',
          columns: [],
          changeSummary: '',
          warnings: [],
        }),
    });
    const n = counter();
    await n.type(cell(w, 1, 'logicalNm'), '연구과제상태코드');
    key(cell(w, 1, 'logicalNm').element, 'Enter');
    await until(() => w.find('[data-testid="ac-listbox"]').exists());
    expect(w.get('[data-testid="ac-listbox"]').text()).toContain('코드구분 후보');
    expect(w.get('[role="option"][data-kind="code"]').text()).toContain('PS/023');
    key(cell(w, 1, 'logicalNm').element, 'Enter');
    await until(() => w.get('tbody tr[data-row="1"]').attributes('data-state') === 'code');
    expect(w.get('tbody tr[data-row="1"] [data-testid="code-picker"]').text()).toContain(
      'PS/023 상태',
    );
    expect(cell(w, 1, 'colComment').element.value).toBe('연구과제상태코드(PS/023 상태)');
    await until(() => document.activeElement === cell(w, 2, 'logicalNm').element);
    expect(n.c).toEqual({ input: 1, click: 0, move: 0 });
    await w.get('#ed-logical').setValue('코드시험');
    key(document.body, 's', { ctrlKey: true });
    await until(() => bodies(calls, 'POST', `${P}/tables`).length === 1);
    expect(bodies(calls, 'POST', `${P}/tables`)[0].columns[0]).toMatchObject({
      logicalNm: '연구과제상태코드',
      physicalNm: 'RSCH_PRJ_STAT_CD',
      codeClsId: 41,
      matchType: 'CODE',
    });
  });
});

describe('T9.8 Ctrl+V 여러 줄 붙여넣기', () => {
  it('논리명 셀에 20줄 → 행 20개 → batch 1회 요청(개별 자동완성 0회)', async () => {
    const { w, calls } = await setup('/projects/RMS/tables/new?bizAreaId=6', {
      [`POST ${P}/autocomplete/columns/batch`]: (r) => {
        const b = JSON.parse(r.body!) as { logicalNms: string[] };
        return json(200, {
          items: b.logicalNms.map((nm, i) =>
            resp(nm, { type: 'exact', applied: applied(`COL_${i + 1}`, { colComment: nm }) }),
          ),
          cacheVersion: 3,
          elapsedMs: 3,
        });
      },
    });
    const lines = Array.from({ length: 20 }, (_, i) => `컬럼${i + 1}\t무시되는 열`).join('\r\n');
    const ev = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: { getData: () => `${lines}\r\n` } });
    cell(w, 1, 'logicalNm').element.dispatchEvent(ev);
    await until(() => w.findAll('tbody tr[data-row]').length === 20);
    await until(() => cell(w, 20, 'physicalNm').element.value === 'COL_20');
    expect(bodies(calls, 'POST', `${P}/autocomplete/columns/batch`)).toHaveLength(1);
    expect(bodies(calls, 'POST', `${P}/autocomplete/columns/batch`)[0].logicalNms).toHaveLength(20);
    expect(bodies(calls, 'POST', `${P}/autocomplete/columns`)).toHaveLength(0);
    expect(cell(w, 1, 'logicalNm').element.value).toBe('컬럼1');
    expect(w.findAll('tbody tr[data-state="exact"]')).toHaveLength(20);
  });
});

describe('빈 새 테이블 DDL 패널(메인 세션 검수 결함)', () => {
  it('테이블명·컬럼이 비면 POST ddl·validate를 보내지 않고 안내 → 입력하면 미리보기', async () => {
    const { w, calls } = await setup('/projects/RMS/tables/new?bizAreaId=17');
    await until(() => w.find('[data-testid="ddl-panel-idle"]').exists());
    expect(w.get('[data-testid="ddl-panel"]').text()).toContain(
      '테이블명과 컬럼을 입력하면 미리보기가 나옵니다',
    );
    expect(w.get('[data-testid="ddl-panel"]').text()).not.toContain('다시 시도');
    await new Promise((r) => setTimeout(r, 700));
    expect(bodies(calls, 'POST', `${P}/ddl`)).toHaveLength(0);
    expect(bodies(calls, 'POST', `${P}/tables/validate`)).toHaveLength(0);
    await w.get('#ed-logical').setValue('빈상태시험');
    await cell(w, 1, 'logicalNm').setValue('사용여부');
    await cell(w, 1, 'physicalNm').setValue('USE_YN');
    await until(() => bodies(calls, 'POST', `${P}/ddl`).length === 1);
    await until(() => w.find('[data-testid="ddl-code"]').text().includes('USE_YN'));
    expect(w.find('[data-testid="ddl-panel-idle"]').exists()).toBe(false);
  });
});

describe('T9.5 물리 테이블명 제안(nmAuto)', () => {
  it('업무구분을 바꾸면 다시 제안(PS_…), 물리명을 직접 고치면 더 이상 제안하지 않는다', async () => {
    const { w, calls } = await setup('/projects/RMS/tables/new?bizAreaId=6');
    await w.get('#ed-logical').setValue('과제접수이력');
    await w.get('#ed-logical').trigger('change');
    await until(() => w.get<HTMLInputElement>('#ed-phys').element.value === 'RP_PRJ_RCPT_HST');
    await w.get('#ed-biz').setValue('9');
    await until(() => w.get<HTMLInputElement>('#ed-phys').element.value === 'PS_PRJ_RCPT_HST');
    expect(bodies(calls, 'POST', `${P}/tables/suggest-name`).at(-1)).toMatchObject({
      bizAreaId: 9,
    });
    const before = bodies(calls, 'POST', `${P}/tables/suggest-name`).length;
    await w.get('#ed-phys').setValue('PS_MY_OWN');
    await w.get('#ed-logical').setValue('다른이름');
    await w.get('#ed-logical').trigger('change');
    await new Promise((r) => setTimeout(r, 50));
    expect(w.get<HTMLInputElement>('#ed-phys').element.value).toBe('PS_MY_OWN');
    expect(bodies(calls, 'POST', `${P}/tables/suggest-name`)).toHaveLength(before);
  });
});

describe('T9.9 재검증 경고 [재적용]', () => {
  it('저장된 composed 컬럼에 W_TERM_CHANGED → [재적용] → 같은 논리명 재자동완성 → 새 물리명', async () => {
    const detail: TableDetail = {
      table: {
        tableId: 17,
        projectKey: 'RMS',
        bizAreaId: 6,
        bizCd: 'RP',
        bizNm: '연구과제',
        tablePrefix: 'RP_',
        bizUseYn: true,
        tableNm: 'RP_TEST_MST',
        tableLogicalNm: '시험',
        description: null,
        status: 'DRAFT',
        version: 3,
        finalizedAt: null,
        finalizedBy: null,
        reviewYn: false,
        reviewNote: null,
        createdBy: 'u',
        createdAt: '2026-09-30T10:00:00',
        updatedBy: 'u',
        updatedByNm: '사용자',
        updatedAt: '2026-09-30T10:00:00',
      },
      columns: [
        {
          columnId: 1,
          colSeq: 1,
          logicalNm: '과제관리번호',
          physicalNm: 'PRJ_MGMT_NO',
          isPk: true,
          dataType: 'VARCHAR',
          dataLength: 20,
          dataScale: null,
          isNullable: false,
          defaultVal: null,
          colComment: '과제관리번호',
          domainId: null,
          codeClsId: null,
          defaultColId: null,
          matchType: 'COMPOSED',
          domainNm: null,
          codeCls: null,
        },
      ],
      errors: [],
      warnings: [
        {
          code: 'W_TERM_CHANGED',
          target: 'column',
          rowIndex: 0,
          columnId: 1,
          field: 'physicalNm',
          message: '표준이 바뀌었습니다: PRJ_MGMT_NO → PRJ_MNGT_NO',
        },
      ],
    };
    const { w, calls } = await setup('/projects/RMS/tables/17', {
      [`GET ${P}/tables/17`]: () => json(200, detail),
    });
    await until(() => w.find('[data-testid="reapply"]').exists());
    // 로드한 행은 Enter로 다시 부르지 않는다(저장값 보호)
    key(cell(w, 1, 'logicalNm').element, 'Enter');
    await until(() => document.activeElement === cell(w, 2, 'logicalNm').element);
    expect(bodies(calls, 'POST', `${P}/autocomplete/columns`)).toHaveLength(0);
    await w.get('[data-testid="reapply"]').trigger('click');
    await until(() => cell(w, 1, 'physicalNm').element.value === 'PRJ_MNGT_NO');
    expect(bodies(calls, 'POST', `${P}/autocomplete/columns`)).toEqual([
      { logicalNm: '과제관리번호', bizAreaId: 6, excludeColumnId: 1 },
    ]);
  });
});

describe('loading 상태', () => {
  it('응답 대기 중 행 우측 스피너(자동완성 중) → 응답 후 exact', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { w } = await setup('/projects/RMS/tables/new?bizAreaId=6', {
      [`POST ${P}/autocomplete/columns`]: async (r) => {
        await gate;
        return acHandler(r);
      },
    });
    await cell(w, 1, 'logicalNm').setValue('사용여부');
    key(cell(w, 1, 'logicalNm').element, 'Enter');
    await until(() => w.get('tbody tr[data-row="1"]').attributes('data-state') === 'loading');
    expect(w.get('tbody tr[data-row="1"]').text()).toContain('자동완성 중');
    release();
    await until(() => w.get('tbody tr[data-row="1"]').attributes('data-state') === 'exact');
    expect(cell(w, 1, 'physicalNm').element.value).toBe('USE_YN');
  });
});
