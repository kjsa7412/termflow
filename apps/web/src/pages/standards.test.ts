import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import type {
  ApprovalPage,
  DomainCalcResult,
  DomainPage,
  ImportPreview,
  MyProject,
  TermItem,
  TermPage,
} from '@termflow/shared';
import { api } from '../api/client.js';
import AppShell from '../components/layout/AppShell.vue';
import BulkImportFlow from '../components/std/BulkImportFlow.vue';
import FilterSeg from '../components/std/FilterSeg.vue';
import ListPager from '../components/std/ListPager.vue';
import { createAppRouter, hasScreen } from '../router.js';
import { useSessionStore } from '../stores/session.js';
import { fakeFetch, json, problem, type FakeRequest, type Handler } from '../test-utils.js';
import ApprovalsPage from './ApprovalsPage.vue';
import CodesPage from './CodesPage.vue';
import DefaultColumnsPage from './DefaultColumnsPage.vue';
import DomainsPage from './DomainsPage.vue';
import TermsPage from './TermsPage.vue';

// T6.11(목록 공통·BulkImportFlow)·T6.12(표준 사전 화면): 인라인 입력행 Enter(S1 단건)·편집 Enter/Esc·조회자 쓰기 숨김·
// ?review=true 필터·L1 미리보기·승인/정정/반려·코드 트리·기본컬럼 저장·사이드바 PENDING 배지·전역 검색
const PA = { id: 2, loginId: 'pa', userNm: '프로젝트관리자', isSysAdmin: false };
const proj = (role: MyProject['role']): MyProject => ({
  key: 'RMS',
  nm: '연구관리시스템',
  role,
  kind: 'PROJECT',
  status: 'ACTIVE',
});
const S = '/api/v1/projects/RMS/standards';

async function setup(path: string, role: MyProject['role'], routes: Record<string, Handler>) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const f = fakeFetch({
    'GET /api/v1/auth/csrf': () => json(200, { token: 'T' }),
    'GET /api/v1/me': () =>
      json(200, { user: PA, mustChangePassword: false, projects: [proj(role)] }),
    ...routes,
  });
  vi.stubGlobal('fetch', f.fetch);
  api.setCsrfToken(null);
  const router = createAppRouter(createMemoryHistory());
  await useSessionStore().refresh();
  await router.push(path);
  return { pinia, router, calls: f.calls };
}
const lastBody = (calls: FakeRequest[], method: string, path: string) =>
  JSON.parse(calls.filter((c) => c.method === method && c.path === path).at(-1)!.body!);
const button = (w: VueWrapper, text: string) =>
  w.findAll('button').find((b) => b.text().includes(text))!;
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
beforeEach(() => localStorage.clear());

const term = (over: Partial<TermItem>): TermItem => ({
  termId: 1,
  termKor: '연구',
  termPhysical: 'RSCH',
  description: 'Research',
  synonymRef: null,
  status: 'APPROVED',
  reviewYn: false,
  reviewNote: null,
  reviewedBy: null,
  reviewedAt: null,
  sharedCnt: 0,
  createdBy: 'MIGRATION',
  createdAt: '2026-03-26T00:00:00',
  updatedBy: 'MIGRATION',
  updatedAt: '2026-03-26T00:00:00',
  ...over,
});
const termPage = (items: TermItem[]): TermPage => ({
  items,
  page: 1,
  size: 20,
  total: items.length,
  counts: { all: 1705, approved: 1700, pending: 3, rejected: 2, shared: 187 },
});

describe('목록 공통 컴포넌트(T6.11)', () => {
  it('FilterSeg: 건수 표시·aria-pressed·선택 시 change', async () => {
    const w = mount(FilterSeg, {
      props: {
        modelValue: '',
        label: '상태',
        options: [
          { value: '', label: '전체', count: 1705 },
          { value: 'PENDING', label: '검토대기', count: 3 },
        ],
      },
    });
    expect(w.findAll('button')[0]!.attributes('aria-pressed')).toBe('true');
    expect(w.text()).toContain('1,705');
    await w.findAll('button')[1]!.trigger('click');
    expect(w.emitted('change')).toEqual([['PENDING']]);
    expect(w.emitted('update:modelValue')).toEqual([['PENDING']]);
  });
  it('ListPager: 범위·쪽 이동·페이지당 변경', async () => {
    const w = mount(ListPager, { props: { page: 1, size: 20, total: 1705 } });
    expect(w.text()).toContain('1–20 / 1,705');
    expect(w.findAll('.page-btn').map((b) => b.text())).toEqual(['‹', '1', '2', '86', '›']);
    await w.get('[aria-label="다음 페이지"]').trigger('click');
    expect(w.emitted('update:page')).toEqual([[2]]);
    await w.get('select').setValue('50');
    expect(w.emitted('update:size')).toEqual([[50]]);
  });
});

describe('TermsPage(04) — S1 단건', () => {
  const list = () =>
    termPage([
      term({}),
      term({ termId: 2, termKor: '책임자', termPhysical: 'RESP', status: 'PENDING', sharedCnt: 1 }),
    ]);
  it('목록·상태 칩 건수·검토대기는 승인 큐 링크, 인라인 입력행 한글·물리약어 → Enter 등록(입력 2·클릭 0)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let created = false;
    const { pinia, router, calls } = await setup('/projects/RMS/standards/terms', 'ADMIN', {
      [`GET ${S}/terms`]: () => json(200, list()),
      [`GET ${S}/terms/check`]: (r) =>
        json(200, {
          korExists: false,
          korTerm: null,
          physicalUsedBy:
            r.query.get('termPhysical') === 'CMTE'
              ? [{ termId: 9, termKor: '위원', termPhysical: 'CMTE', status: 'APPROVED' }]
              : [],
        }),
      [`POST ${S}/terms`]: () => {
        created = true;
        return json(201, {
          term: term({ termId: 3, termKor: '위원회', termPhysical: 'CMTE' }),
          physicalConflicts: [
            { termId: 9, termKor: '위원', termPhysical: 'CMTE', status: 'APPROVED' },
          ],
          warnings: [],
        });
      },
    });
    const w = mount(TermsPage, { global: { plugins: [pinia, router] }, attachTo: document.body });
    await flushPromises();
    expect(w.text()).toContain('1,705');
    expect(w.text()).toMatch(/검토대기\s*3/);
    expect(w.find(`a[href="/projects/RMS/standards/approvals"]`).exists()).toBe(true);
    expect(w.text()).toContain('물리약어 공유 1');
    const kor = w.get('input[aria-label="한글 용어"]');
    await kor.setValue('위원회');
    await w.get('input[aria-label="물리약어"]').setValue('cmte');
    expect((w.get('input[aria-label="물리약어"]').element as HTMLInputElement).value).toBe('CMTE');
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();
    expect(w.get('[data-testid="draft-msg"]').text()).toContain("'위원'와 공유 중");
    await kor.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(created).toBe(true);
    expect(lastBody(calls, 'POST', `${S}/terms`)).toEqual({
      termKor: '위원회',
      termPhysical: 'CMTE',
      description: null,
      synonymRef: null,
    });
    w.unmount();
  });

  it('형식 오류(소문자·기호)는 등록 버튼 비활성, 검색·필터는 서버 쿼리(URL 동기화)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { pinia, router, calls } = await setup(
      '/projects/RMS/standards/terms?status=PENDING',
      'ADMIN',
      {
        [`GET ${S}/terms`]: () => json(200, list()),
        [`GET ${S}/terms/check`]: () =>
          json(200, { korExists: false, korTerm: null, physicalUsedBy: [] }),
      },
    );
    const w = mount(TermsPage, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(calls.find((c) => c.path === `${S}/terms`)!.query.get('status')).toBe('PENDING');
    await w.get('input[aria-label="한글 용어"]').setValue('연구과제');
    await w.get('input[aria-label="물리약어"]').setValue('RSCH-PRJ');
    await flushPromises();
    expect(button(w, '등록').attributes('disabled')).toBeDefined();
    expect(w.text()).toContain('허용되지 않는 문자');
    await w.get('input[aria-label="용어 검색"]').setValue('과제');
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();
    const q = calls.filter((c) => c.path === `${S}/terms`).at(-1)!.query;
    expect(q.get('q')).toBe('과제');
    expect(router.currentRoute.value.query).toMatchObject({ q: '과제', status: 'PENDING' });
  });

  it('행 편집: Enter 저장(PUT)·Esc 취소, 변경이력 펼침', async () => {
    const { pinia, router, calls } = await setup('/projects/RMS/standards/terms', 'ADMIN', {
      [`GET ${S}/terms`]: () => json(200, list()),
      [`PUT ${S}/terms/1`]: () =>
        json(200, {
          term: term({ description: '연구(수정)' }),
          physicalConflicts: [],
          warnings: [],
        }),
      [`GET ${S}/audit-logs`]: () =>
        json(200, {
          items: [
            {
              auditId: 1,
              entityType: 'TERM',
              entityId: 1,
              action: 'UPDATE',
              before: { description: 'Research' },
              after: { description: '연구(수정)' },
              changedFields: ['description'],
              batchId: null,
              actor: 'pa',
              actorIp: null,
              actedAt: '2026-09-29T10:00:00',
            },
          ],
          page: 1,
          size: 20,
          total: 1,
        }),
    });
    const w = mount(TermsPage, { global: { plugins: [pinia, router] }, attachTo: document.body });
    await flushPromises();
    await w.get('[aria-label="연구 행 메뉴"]').trigger('click');
    await button(w, '수정').trigger('click');
    const desc = w.findAll('tr.is-editing input[aria-label="설명"]')[0]!;
    await desc.setValue('연구(수정)');
    await desc.trigger('keydown', { key: 'Escape' });
    expect(w.find('tr.is-editing').exists()).toBe(false);
    await w.get('[aria-label="연구 행 메뉴"]').trigger('click');
    await button(w, '수정').trigger('click');
    await w.get('tr.is-editing input[aria-label="설명"]').setValue('연구(수정)');
    await w.get('tr.is-editing input[aria-label="설명"]').trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(lastBody(calls, 'PUT', `${S}/terms/1`)).toMatchObject({ description: '연구(수정)' });
    await w.get('[aria-label="연구 행 메뉴"]').trigger('click');
    await button(w, '변경이력').trigger('click');
    await flushPromises();
    // 필드는 화면 이름으로(내부 컬럼명 description 아님, CR-15 C5)
    expect(w.get('[data-testid="audit-history"]').text()).toContain('설명: Research → 연구(수정)');
    w.unmount();
  });

  it('조회자: 인라인 입력행·일괄 등록·수정·삭제 숨김(변경이력만)', async () => {
    const { pinia, router } = await setup('/projects/RMS/standards/terms', 'VIEWER', {
      [`GET ${S}/terms`]: () => json(200, list()),
    });
    const w = mount(TermsPage, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(w.find('tr.is-inline-new').exists()).toBe(false);
    expect(w.find('a[href="/projects/RMS/standards/terms/import"]').exists()).toBe(false);
    await w.get('[aria-label="연구 행 메뉴"]').trigger('click');
    expect(
      w
        .findAll('.dropdown-menu')[0]!
        .findAll('.dropdown-item')
        .map((b) => b.text()),
    ).toEqual(['변경이력']);
    expect(w.text()).toContain('프로젝트 관리자만 편집할 수 있습니다');
  });

  it('없는 프로젝트(404) → 프로젝트를 찾을 수 없습니다', async () => {
    const { pinia, router } = await setup('/projects/RMS/standards/terms', 'ADMIN', {
      [`GET ${S}/terms`]: () => problem(404, 'not-found', 'E_NOT_FOUND'),
    });
    const w = mount(TermsPage, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(w.text()).toContain('프로젝트를 찾을 수 없습니다');
  });
});

describe('BulkImportFlow(04b) — S1 엑셀', () => {
  const preview = (over: Partial<ImportPreview> = {}): ImportPreview => ({
    importId: '11111111-1111-4111-8111-111111111111',
    kind: 'terms',
    fileName: '용어.xlsx',
    totalRows: 3,
    summary: { new: 1, update: 1, skip: 0, error: 1, warn: 1 },
    columns: [
      { key: 'termKor', label: '한글용어', required: true },
      { key: 'termPhysical', label: '물리약어', required: true },
    ],
    createdAt: '2026-09-29T13:00:00',
    expiresAt: '2026-09-29T13:30:00',
    elapsedMs: 12,
    items: [
      {
        rowNo: 2,
        status: 'NEW',
        key: '위원회',
        values: { termKor: '위원회', termPhysical: 'CMTE' },
        changes: {},
        errors: [],
        warnings: [{ code: 'W_TERM_PHYSICAL_SHARED', message: '공유: 위원' }],
      },
      {
        rowNo: 3,
        status: 'UPDATE',
        key: '연구',
        values: { termKor: '연구', termPhysical: 'RSCH' },
        changes: { description: ['A', 'B'] },
        errors: [],
        warnings: [],
      },
      {
        rowNo: 4,
        status: 'ERROR',
        key: '연구과제',
        values: { termKor: '연구과제', termPhysical: 'RSCH-PRJ' },
        changes: {},
        errors: [
          { code: 'E_TERM_PHYSICAL_FORMAT', message: '허용되지 않는 문자', field: 'termPhysical' },
        ],
        warnings: [],
      },
    ],
    page: 1,
    size: 100,
    total: 3,
    ...over,
  });
  it('업로드 → 색 구분 미리보기(신규·갱신·오류) → 필터 → 적용(오류 제외) → 결과', async () => {
    const { pinia, router, calls } = await setup('/projects/RMS/standards/terms/import', 'ADMIN', {
      [`POST ${S}/terms/imports`]: () => json(201, preview()),
      [`GET ${S}/imports/11111111-1111-4111-8111-111111111111`]: () =>
        json(200, preview({ items: [preview().items[2]!], total: 1 })),
      [`POST ${S}/imports/11111111-1111-4111-8111-111111111111/apply`]: () =>
        json(200, {
          applied: { new: 1, update: 1 },
          skipped: 0,
          errors: 1,
          batchId: 'abcdef12-0000',
          elapsedMs: 40,
        }),
    });
    const w = mount(BulkImportFlow, {
      props: { projectKey: 'RMS', kind: 'terms', title: '용어' },
      global: { plugins: [pinia, router] },
    });
    const input = w.get('input[type="file"]');
    const file = new File(['PK'], '용어.xlsx');
    Object.defineProperty(input.element, 'files', { value: [file] });
    await input.trigger('change');
    await flushPromises();
    expect(calls.some((c) => c.method === 'POST' && c.path === `${S}/terms/imports`)).toBe(true);
    expect(w.get('[data-testid="summary"]').text()).toMatch(
      /신규\s*1.*갱신\s*1.*동일\s*0.*오류\s*1/s,
    );
    expect(w.findAll('tbody tr').map((r) => r.attributes('data-status'))).toEqual([
      'NEW',
      'UPDATE',
      'ERROR',
    ]);
    expect(w.text()).toContain('description: A → B');
    expect(w.find('td.text-danger').text()).toBe('RSCH-PRJ');
    await button(w, '오류').trigger('click');
    await flushPromises();
    expect(calls.at(-1)!.query.get('status')).toBe('ERROR');
    await button(w, '2행 적용').trigger('click');
    await flushPromises();
    expect(
      lastBody(calls, 'POST', `${S}/imports/11111111-1111-4111-8111-111111111111/apply`),
    ).toEqual({
      skipErrors: true,
    });
    expect(w.get('[data-testid="import-result"]').text()).toContain(
      '신규 1 · 갱신 1 · 동일 0 · 오류 제외 1',
    );
    expect(w.emitted('done')).toHaveLength(1);
  });
  it('업로드 오류(헤더 다름 422)는 알림으로 표시, 오류 제외를 끄면 오류가 있을 때 적용 비활성', async () => {
    let bad = true;
    const { pinia, router } = await setup('/projects/RMS/standards/terms/import', 'ADMIN', {
      [`POST ${S}/terms/imports`]: () =>
        bad
          ? problem(422, 'validation', 'E_VALIDATION', {
              errors: [{ code: 'E_IMPORT_HEADER', message: '템플릿 헤더와 다릅니다' }],
            })
          : json(201, preview()),
    });
    const w = mount(BulkImportFlow, {
      props: { projectKey: 'RMS', kind: 'terms', title: '용어' },
      global: { plugins: [pinia, router] },
    });
    const input = w.get('input[type="file"]');
    Object.defineProperty(input.element, 'files', {
      value: [new File(['x'], 'a.xlsx')],
      configurable: true,
    });
    await input.trigger('change');
    await flushPromises();
    expect(w.get('[role="alert"]').text()).toContain('템플릿 헤더와 다릅니다');
    bad = false;
    await input.trigger('change');
    await flushPromises();
    await w.get('input[type="checkbox"]').setValue(false);
    expect(button(w, '행 적용').attributes('disabled')).toBeDefined();
  });
});

describe('DomainsPage(06)', () => {
  const page = (): DomainPage => ({
    items: [
      {
        domainId: 7,
        nm: ['건', '마찰', '정보', null, null, null, null],
        logicalNm: '건마찰정보',
        physicalNm: null,
        descr: null,
        suffix: 'INFO',
        domainClsId: 1,
        colType: 'VARCHAR',
        colLength: 1000,
        colScale: null,
        typeText: 'VARCHAR(1000)',
        typeSource: 'AUTO',
        reviewYn: true,
        reviewNote: '미등록 조각: 마찰',
        updatedBy: 'MIGRATION',
        updatedAt: '2026-03-26T00:00:00',
      },
    ],
    page: 1,
    size: 20,
    total: 1,
    counts: { all: 4587, review: 293, noPhysical: 132, manual: 376 },
  });
  const calc: DomainCalcResult = {
    logicalNm: '가격인하금액',
    physicalNm: 'PRICE_REDU_AMT',
    assembledPhysical: 'PRICE_REDU_AMT',
    descr: '가격_인하_금액',
    suffix: 'AMT',
    domainClsId: 3,
    colType: 'BIGINT',
    colLength: null,
    colScale: null,
    typeText: 'BIGINT',
    typeSource: 'AUTO',
    pieces: [
      { kor: '가격', physical: 'PRICE', matched: true, numeric: false },
      { kor: '인하', physical: 'REDU', matched: true, numeric: false },
      { kor: '금액', physical: 'AMT', matched: true, numeric: false },
    ],
    notFound: [],
    reviewReasons: [],
    duplicate: null,
    errors: [],
    warnings: [],
  };
  it('?review=true(홈 C3 배너 링크)로 들어오면 검토필요 칩 선택 + review 필터 조회, 검토 사유 표시', async () => {
    expect(hasScreen('/projects/RMS/standards/domains?review=true')).toBe(true);
    const { pinia, router, calls } = await setup(
      '/projects/RMS/standards/domains?review=true',
      'VIEWER',
      {
        [`GET ${S}/domains`]: () => json(200, page()),
      },
    );
    const w = mount(DomainsPage, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(calls.find((c) => c.path === `${S}/domains`)!.query.get('review')).toBe('true');
    expect(w.find('[aria-pressed="true"]').text()).toContain('검토필요');
    expect(w.text()).toContain('미등록 조각: 마찰');
    expect(w.find('[data-testid="composer"]').exists()).toBe(false);
    expect(w.text()).not.toContain('재계산');
  });
  it('도메인 등록: 명칭 조각 입력 → L1 미리보기(물리명·접미어→타입·조각) → Enter 등록, 재계산 결과 표시', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { pinia, router, calls } = await setup('/projects/RMS/standards/domains', 'ADMIN', {
      [`GET ${S}/domains`]: () => json(200, page()),
      [`POST ${S}/domains/calculate`]: () => json(200, calc),
      [`POST ${S}/domains`]: () =>
        json(201, {
          domain: {
            ...page().items[0]!,
            logicalNm: '가격인하금액',
            physicalNm: 'PRICE_REDU_AMT',
            reviewYn: false,
            typeText: 'BIGINT',
          },
          warnings: [],
        }),
      [`POST ${S}/domains/recalculate`]: () =>
        json(200, {
          scope: 'REVIEW_ONLY',
          target: 293,
          updated: 14,
          resolved: 10,
          stillReview: 283,
          batchId: 'b',
          elapsedMs: 30,
          report: [
            {
              domainId: 7,
              logicalNm: '건마찰정보',
              changes: { physicalNm: [null, 'GUN_FRIC_INFO'] },
              reviewYn: false,
              reviewNote: null,
            },
          ],
        }),
    });
    const w = mount(DomainsPage, { global: { plugins: [pinia, router] }, attachTo: document.body });
    await flushPromises();
    await button(w, '도메인 등록').trigger('click');
    await w.get('#nm1').setValue('가격');
    await w.get('#nm2').setValue('인하');
    await w.get('#nm3').setValue('금액');
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();
    const box = w.get('[data-testid="calc"]').text();
    expect(box).toContain('가격인하금액');
    expect(box).toContain('PRICE_REDU_AMT');
    expect(box).toContain('AMT');
    expect(box).toContain('BIGINT');
    expect(w.findAll('.piece-ok')).toHaveLength(3);
    await w.get('#nm3').trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(lastBody(calls, 'POST', `${S}/domains`)).toMatchObject({
      nm1: '가격',
      nm2: '인하',
      nm3: '금액',
      typeSource: 'AUTO',
      colType: null,
    });
    await button(w, '재계산').trigger('click');
    await button(w, '검토필요 도메인만').trigger('click');
    await flushPromises();
    expect(lastBody(calls, 'POST', `${S}/domains/recalculate`)).toEqual({ scope: 'REVIEW_ONLY' });
    expect(w.get('[data-testid="recalc-result"]').text()).toContain(
      '변경 14 · 검토 해제 10 · 남은 검토 283',
    );
    expect(w.get('[data-testid="recalc-result"]').text()).toContain('물리명: — → GUN_FRIC_INFO');
    w.unmount();
  });
});

describe('ApprovalsPage(11)', () => {
  const item = (id: number, kor: string, conflicts = false) => ({
    ...term({
      termId: id,
      termKor: kor,
      termPhysical: conflicts ? 'RESP' : 'RPMC',
      status: 'PENDING' as const,
      createdBy: '김설계',
    }),
    physicalConflicts: conflicts
      ? [{ termId: 50, termKor: '응답', termPhysical: 'RESP', status: 'APPROVED' as const }]
      : [],
    columnCnt: 1,
    columnSamples: [{ tableNm: 'RP_RSCH_PRJ_MAST', logicalNm: '연구책임자구분' }],
  });
  const q = (): ApprovalPage => ({
    items: [item(1, '책임자', true), item(2, '연관위')],
    page: 1,
    size: 20,
    total: 2,
    counts: { pending: 2, processed: 41 },
  });
  it('충돌 경고·정정 후 승인(물리약어 변경 본문)·반려(사유 필수)·충돌 없는 항목 일괄 승인', async () => {
    const { pinia, router, calls } = await setup('/projects/RMS/standards/approvals', 'ADMIN', {
      [`GET ${S}/approvals`]: () => json(200, q()),
      [`POST ${S}/approvals/1/approve`]: () =>
        json(200, {
          term: term({ termId: 1, termKor: '책임자', termPhysical: 'RSPNS' }),
          physicalConflicts: [],
          warnings: [],
        }),
      [`POST ${S}/approvals/2/reject`]: () =>
        json(200, { term: term({ termId: 2 }), physicalConflicts: [], warnings: [] }),
      [`POST ${S}/approvals/approve-batch`]: () => json(200, { approved: 1, termIds: [2] }),
    });
    const w = mount(ApprovalsPage, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(w.text()).toContain('물리약어 충돌');
    expect(w.text()).toContain("'응답'(RESP)와 공유");
    expect(w.text()).toContain('RP_RSCH_PRJ_MAST');
    await w.get('input[aria-label="책임자 물리약어 정정"]').setValue('rspns');
    expect(button(w, '정정 후 승인').exists()).toBe(true);
    await button(w, '정정 후 승인').trigger('click');
    await flushPromises();
    expect(lastBody(calls, 'POST', `${S}/approvals/1/approve`)).toEqual({
      termPhysical: 'RSPNS',
      description: 'Research',
    });
    const rejectBtns = w.findAll('button').filter((b) => b.text() === '반려');
    await rejectBtns[1]!.trigger('click');
    expect(button(w, '반려 확정').attributes('disabled')).toBeDefined();
    await w.get('input[aria-label="연관위 반려 사유"]').setValue('처리로 통일');
    await button(w, '반려 확정').trigger('click');
    await flushPromises();
    expect(lastBody(calls, 'POST', `${S}/approvals/2/reject`)).toEqual({ note: '처리로 통일' });
    await button(w, '충돌 없는 항목 일괄 승인').trigger('click');
    await flushPromises();
    expect(lastBody(calls, 'POST', `${S}/approvals/approve-batch`)).toEqual({ termIds: [2] });
  });
});

describe('CodesPage(07)·DefaultColumnsPage', () => {
  it('코드: 업무구분 트리 → 코드구분 선택(?cls) → 코드 인라인 추가(Enter), 사용 중지 업무구분에는 추가 버튼 없음', async () => {
    const cls = {
      codeClsId: 5,
      bizAreaId: 1,
      bizCd: 'RP',
      bizNm: '연구과제',
      bizUseYn: true,
      codeCls: '010',
      codeClsNm: '연구분류',
      description: null,
      codeCnt: 1,
      activeCodeCnt: 1,
      columnCnt: 3,
      updatedBy: 'MIGRATION',
      updatedAt: '2026-03-26T00:00:00',
    };
    const { pinia, router, calls } = await setup('/projects/RMS/standards/codes', 'ADMIN', {
      'GET /api/v1/projects/RMS/biz-areas': () =>
        json(200, [
          {
            bizAreaId: 1,
            bizCd: 'RP',
            bizNm: '연구과제',
            tablePrefix: 'RP_',
            sortNo: 1,
            useYn: true,
            description: null,
            tableCnt: 33,
            codeClsCnt: 1,
            locked: true,
            origin: null,
          },
          {
            bizAreaId: 2,
            bizCd: 'PS',
            bizNm: '인사',
            tablePrefix: 'PS_',
            sortNo: 2,
            useYn: false,
            description: null,
            tableCnt: 0,
            codeClsCnt: 0,
            locked: false,
            origin: null,
          },
        ]),
      [`GET ${S}/code-classes`]: () => json(200, { items: [cls], page: 1, size: 200, total: 1 }),
      [`GET ${S}/code-classes/5`]: () =>
        json(200, {
          codeCls: cls,
          codes: [
            {
              codeId: 1,
              codeClsId: 5,
              code: '010',
              codeNm: '정책과제',
              sortOrder: 1,
              isActive: true,
              updatedBy: 'm',
              updatedAt: '2026-03-26T00:00:00',
            },
          ],
          columnSamples: ['RP_RSCH_PRJ_MAST.RSCH_CLS_CD'],
        }),
      [`POST ${S}/code-classes/5/codes`]: () =>
        json(201, {
          codeId: 2,
          codeClsId: 5,
          code: '020',
          codeNm: '기본과제',
          sortOrder: 2,
          isActive: true,
          updatedBy: 'pa',
          updatedAt: '2026-09-29T00:00:00',
        }),
    });
    const w = mount(CodesPage, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(w.find('[aria-label="RP에 코드구분 추가"]').exists()).toBe(true);
    expect(w.find('[aria-label="PS에 코드구분 추가"]').exists()).toBe(false);
    await w.findAll('.tree-node')[0]!.trigger('click');
    await w
      .findAll('.tree-node')
      .find((n) => n.text().includes('연구분류'))!
      .trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query['cls']).toBe('5');
    expect(w.get('[data-testid="cls-card"]').text()).toContain('RP/010');
    expect(w.text()).toContain('연구분류(RP/010: 010 정책과제)');
    await w.get('input[aria-label="코드"]').setValue('020');
    await w.get('input[aria-label="코드명"]').setValue('기본과제');
    await w.get('input[aria-label="코드명"]').trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(lastBody(calls, 'POST', `${S}/code-classes/5/codes`)).toEqual({
      code: '020',
      codeNm: '기본과제',
      sortOrder: null,
      isActive: true,
    });
  });

  it('기본컬럼: 세트 선택·행 추가(물리명 대문자)·PK 체크 시 NULL 해제·저장(PUT columns, 기존 ID 유지)', async () => {
    const set = {
      setId: 1,
      setNm: '기본',
      description: null,
      isDefault: true,
      colCnt: 1,
      columnRefCnt: 297,
      updatedBy: 'MIGRATION',
      updatedAt: '2026-03-26T00:00:00',
      columns: [
        {
          defaultColId: 11,
          colSeq: 1,
          logicalNm: '최초등록일시',
          physicalNm: 'FIRS_REG_DTS',
          isPk: false,
          dataType: 'TIMESTAMP',
          dataLength: 0,
          dataScale: null,
          typeText: 'TIMESTAMP(0)',
          isNullable: true,
          defaultVal: 'CURRENT_TIMESTAMP',
          colComment: null,
        },
      ],
    };
    const { pinia, router, calls } = await setup(
      '/projects/RMS/standards/default-columns',
      'ADMIN',
      {
        [`GET ${S}/default-column-sets`]: () => json(200, [set]),
        [`PUT ${S}/default-column-sets/1/columns`]: () => json(200, { ...set, colCnt: 2 }),
      },
    );
    const w = mount(DefaultColumnsPage, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(w.text()).toContain('기본');
    expect(button(w, '저장').attributes('disabled')).toBeDefined();
    await button(w, '행 추가').trigger('click');
    await w.get('input[aria-label="2행 논리명"]').setValue('삭제여부');
    await w.get('input[aria-label="2행 물리명"]').setValue('del_yn');
    await w.get('input[aria-label="2행 PK"]').setValue(true);
    expect((w.get('input[aria-label="2행 NULL 허용"]').element as HTMLInputElement).checked).toBe(
      false,
    );
    await button(w, '저장').trigger('click');
    await flushPromises();
    const body = lastBody(calls, 'PUT', `${S}/default-column-sets/1/columns`);
    expect(
      body.columns.map((c: { defaultColId: number | null; physicalNm: string }) => [
        c.defaultColId,
        c.physicalNm,
      ]),
    ).toEqual([
      [11, 'FIRS_REG_DTS'],
      [null, 'DEL_YN'],
    ]);
    expect(body.columns[1]).toMatchObject({ isPk: true, isNullable: false });
  });
});

describe('앱 셸: 사이드바 표준 사전 메뉴·PENDING 배지·전역 검색', () => {
  it('프로젝트 관리자: 승인 큐 배지(건수), 조회자: 승인 큐 메뉴 없음', async () => {
    const { pinia, router } = await setup('/projects/RMS/standards/terms', 'ADMIN', {
      [`GET ${S}/terms`]: () => json(200, termPage([])),
      [`GET ${S}/approvals/count`]: () => json(200, { pending: 3 }),
    });
    const w = mount(AppShell, { global: { plugins: [pinia, router] } });
    await flushPromises();
    const links = w.findAll('.nav-item').map((n) => n.text());
    expect(links).toEqual(
      expect.arrayContaining(['용어', '도메인분류', '도메인', '코드', '기본컬럼']),
    );
    expect(w.get('[data-testid="pending-badge"]').text()).toBe('3');
    expect(w.find('a[href="/projects/RMS/standards/approvals"]').exists()).toBe(true);
  });
  it('전역 검색: 현재 프로젝트 P/search → 용어·도메인 결과 → Enter로 이동', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { pinia, router, calls } = await setup('/projects/RMS/standards/terms', 'VIEWER', {
      [`GET ${S}/terms`]: () => json(200, termPage([])),
      'GET /api/v1/projects/RMS/search': () =>
        json(200, {
          terms: [{ termId: 1, termKor: '과제', termPhysical: 'PRJ', status: 'APPROVED' }],
          domains: [
            {
              domainId: 3,
              logicalNm: '과제번호',
              physicalNm: 'PRJ_NO',
              typeText: 'VARCHAR(20)',
              reviewYn: false,
            },
          ],
          tables: [],
        }),
    });
    const w = mount(AppShell, { global: { plugins: [pinia, router] }, attachTo: document.body });
    await flushPromises();
    expect(w.find('a[href="/projects/RMS/standards/approvals"]').exists()).toBe(false);
    const input = w.get('input[aria-label="전역 검색(현재 프로젝트 범위)"]');
    await input.setValue('과제');
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();
    expect(calls.find((c) => c.path === '/api/v1/projects/RMS/search')!.query.get('q')).toBe(
      '과제',
    );
    const res = w.get('[data-testid="search-results"]').text();
    expect(res).toContain('용어');
    expect(res).toContain('과제번호');
    await input.trigger('keydown', { key: 'ArrowDown' });
    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe(
      `/projects/RMS/standards/domains?q=${encodeURIComponent('과제번호')}`,
    );
    w.unmount();
  });
});
