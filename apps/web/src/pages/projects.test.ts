import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import type { CopySourcesResponse, MyProject } from '@termflow/shared';
import { api } from '../api/client.js';
import AppShell from '../components/layout/AppShell.vue';
import { createAppRouter } from '../router.js';
import { useSessionStore } from '../stores/session.js';
import { useToastStore } from '../stores/toast.js';
import {
  fakeFetch,
  json,
  problem,
  type FakeRequest,
  type Handler,
  untilRoute,
} from '../test-utils.js';
import AdminProjectsPage from './AdminProjectsPage.vue';
import AdminTemplatesPage from './AdminTemplatesPage.vue';
import BizAreasPage from './BizAreasPage.vue';
import ProjectNewPage from './ProjectNewPage.vue';
import ProjectSettingsPage from './ProjectSettingsPage.vue';
import ProjectsPage from './ProjectsPage.vue';

// T5.12·T5.13 화면: 목록·마법사(S5 계수)·설정(멤버·수명주기)·업무구분(자물쇠·삭제 건수)·시스템 프로젝트·템플릿·사이드바
const SA = { id: 1, loginId: 'admin', userNm: '관리자', isSysAdmin: true };
const PA = { id: 2, loginId: 'pa', userNm: '프로젝트관리자', isSysAdmin: false };
const proj = (
  key: string,
  role: MyProject['role'] = 'ADMIN',
  kind: MyProject['kind'] = 'PROJECT',
): MyProject => ({
  key,
  nm: `${key} 이름`,
  role,
  kind,
  status: 'ACTIVE',
});
const counts = {
  bizArea: 6,
  term: 1705,
  termApproved: 1705,
  domainCls: 84,
  domain: 4587,
  codeCls: 159,
  code: 991,
  defaultColSet: 1,
  defaultCol: 9,
};
const SOURCES: CopySourcesResponse = {
  templates: [
    {
      key: 'STDV1',
      nm: 'TermFlow 기본 표준 v1',
      kind: 'TEMPLATE',
      status: 'ACTIVE',
      counts,
      bizAreas: ['AC', 'BD', 'CT', 'GW', 'PS', 'RP'].map((b) => ({
        bizCd: b,
        bizNm: b,
        codeClsCnt: 1,
        codeCnt: 1,
      })),
    },
  ],
  projects: [
    {
      key: 'RMS',
      nm: '연구관리시스템(이관)',
      kind: 'PROJECT',
      status: 'ACTIVE',
      counts,
      bizAreas: [],
    },
  ],
};

async function setup(
  path: string,
  user: typeof SA,
  projects: MyProject[],
  routes: Record<string, Handler>,
) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const f = fakeFetch({
    'GET /api/v1/auth/csrf': () => json(200, { token: 'T' }),
    'GET /api/v1/me': () => json(200, { user, mustChangePassword: false, projects }),
    ...routes,
  });
  vi.stubGlobal('fetch', f.fetch);
  api.setCsrfToken(null);
  const router = createAppRouter(createMemoryHistory());
  await useSessionStore().refresh();
  await router.push(path);
  return { pinia, router, calls: f.calls };
}
const bodyOf = (calls: FakeRequest[], method: string, path: string) =>
  JSON.parse(calls.filter((c) => c.method === method && c.path === path).at(-1)!.body!);
const button = (w: VueWrapper, text: string) =>
  w.findAll('button').find((b) => b.text().includes(text))!;
beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ProjectsPage(02)', () => {
  const card = {
    key: 'RMS',
    nm: '연구관리시스템(이관)',
    description: '승계',
    myRole: 'ADMIN',
    isMember: true,
    bizAreas: [
      { bizCd: 'RP', bizNm: '연구과제', tableCnt: 33, useYn: true },
      { bizCd: 'PS', bizNm: '인사', tableCnt: 0, useYn: false },
    ],
    tableCnt: 33,
    memberCnt: 1,
    lastChangedAt: '2026-09-28T12:41:00',
    lastChangedBy: 'MIGRATION',
    status: 'ACTIVE',
    defaultDialect: 'POSTGRESQL',
  };
  it('카드: 키·이름·역할·업무구분 칩(테이블 수, 사용 중지 회색)·테이블·멤버, SA만 [새 프로젝트]', async () => {
    const { pinia, router } = await setup('/projects', SA, [proj('RMS')], {
      'GET /api/v1/projects': () => json(200, [card]),
    });
    const w = mount(ProjectsPage, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(w.get('.project-card').text()).toContain('연구관리시스템(이관)');
    expect(w.findAll('.badge.mono').map((b) => b.text())).toEqual(['RP 33', 'PS']);
    expect(w.find('.badge-gray.mono').text()).toBe('PS');
    expect(w.text()).toContain('테이블 33');
    expect(w.find('a[href="/projects/new"]').exists()).toBe(true);
  });
  it('일반 사용자: [새 프로젝트] 없음, 빈 상태 안내', async () => {
    const { pinia, router } = await setup('/projects', PA, [], {
      'GET /api/v1/projects': () => json(200, []),
    });
    const w = mount(ProjectsPage, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(w.find('a[href="/projects/new"]').exists()).toBe(false);
    expect(w.text()).toContain('시스템 관리자에게 프로젝트 멤버 추가를 요청하세요');
  });
});

describe('ProjectNewPage(02b) — S5 계수·미리보기·C3 경고', () => {
  const preview = (c3 = false) =>
    json(200, {
      items: [
        ['BIZ_AREA', 6],
        ['TERM', 1705],
        ['DOMAIN_CLS', 84],
        ['DOMAIN', 4587],
        ['CODE_CLS', 159],
        ['CODE', 991],
        ['DEFAULT_COL_SET', 1],
        ['DEFAULT_COL', 9],
      ].map(([item, n]) => ({
        item,
        sourceKind: 'TEMPLATE',
        sourceKey: 'STDV1',
        sourceCnt: n,
        toCopy: n,
        toSkip: 0,
        warnings: [],
      })),
      c3Expected: c3,
      warnings: [],
    });
  const created = {
    projectKey: 'HRM26',
    projectId: 9,
    batchId: 'b',
    elapsedMs: 1840,
    items: [
      {
        item: 'DOMAIN',
        sourceKind: 'PROJECT',
        sourceKey: 'RMS',
        sourceCnt: 4587,
        copied: 4587,
        skipped: 0,
        flagged: 12,
      },
    ],
    c3Revalidation: {
      performed: true,
      reason: '용어·도메인분류(STDV1)와 도메인(RMS) 원본이 다름',
      reviewDomainCnt: 305,
      flaggedCnt: 12,
      reviewListUrl: '/projects/HRM26/standards/domains?review=true',
      samples: [{ domainId: 1, logicalNm: '연구책임자구분', reason: '미등록 조각: 책임자' }],
    },
    warnings: [],
  };

  it('입력 4 · 클릭 5 · 이동 1로 생성(멤버 1명 추가) → 결과 요약(C3 배너) → 홈', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { pinia, router, calls } = await setup('/projects/new', SA, [], {
      'GET /api/v1/projects/copy-sources': () => json(200, SOURCES),
      'GET /api/v1/projects/check-key': (r) =>
        json(200, { available: r.query.get('key') === 'HRM26' }),
      'POST /api/v1/projects/copy-preview': () => preview(),
      'GET /api/v1/admin/users': () =>
        json(200, {
          items: [
            { id: 7, loginId: 'choijh', userNm: '최조회', isActive: true, isSysAdmin: false },
          ],
          page: 1,
          size: 10,
          total: 1,
          counts: {},
        }),
      'POST /api/v1/projects': () => json(201, created),
      'GET /api/v1/projects/HRM26': () => problem(404, 'not-found', 'E_NOT_FOUND'),
    });
    const w = mount(ProjectNewPage, {
      global: { plugins: [pinia, router] },
      attachTo: document.body,
    });
    await flushPromises();
    const ops = { input: 0, click: 0 };
    const type = async (sel: string, v: string) => (ops.input++, await w.get(sel).setValue(v));
    const click = async (el: { trigger: (e: string) => Promise<void> }) => (
      ops.click++,
      await el.trigger('click')
    );

    await type('#n-name', 'OO기관 인사시스템 고도화');
    await type('#n-key', 'hrm26'); // 대문자로 자동 변환
    await type('#n-desc', '2026 인사 고도화');
    await vi.advanceTimersByTimeAsync(400);
    await flushPromises();
    expect((w.get('#n-key').element as HTMLInputElement).value).toBe('HRM26');
    expect(w.text()).toContain('사용 가능');
    // 미리보기(기본: 모든 항목 STDV1)
    expect(w.get('[data-testid="preview"]').text()).toContain('4,587');
    await type('input[aria-label="멤버 검색"]', '최조');
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();
    await click(w.get('[role="option"]'));
    ops.click++;
    await w.get('select[aria-label="역할"]').setValue('VIEWER');
    await click(button(w, '추가'));
    expect(w.text()).toContain('choijh');
    await click(button(w, '생성'));
    await flushPromises();

    const body = bodyOf(calls, 'POST', '/api/v1/projects');
    expect(body).toMatchObject({
      projectKey: 'HRM26',
      projectNm: 'OO기관 인사시스템 고도화',
      description: '2026 인사 고도화',
      defaultDialect: 'POSTGRESQL',
      members: [{ userId: 7, role: 'VIEWER' }],
    });
    const t = { source: 'TEMPLATE', sourceKey: 'STDV1' };
    expect(body.imports).toEqual({
      bizAreas: t,
      terms: { ...t, approvedOnly: true },
      domainClasses: t,
      domains: t,
      codes: t,
      defaultColSets: t,
    });
    expect(w.get('[data-testid="review-banner"]').text()).toContain('검토필요 도메인 305건');
    expect(w.text()).toContain('새로 표시 12건');
    await click(button(w, '프로젝트 홈으로'));
    await flushPromises();
    await untilRoute(router, '/projects/HRM26');
    // S5 합격 기준(§13.2): 입력 4 / 클릭 6 / 이동 1(목록 → 마법사) 이내
    expect(ops.input).toBeLessThanOrEqual(4);
    expect(ops.click).toBeLessThanOrEqual(6);
    w.unmount();
  });

  it('도메인만 다른 프로젝트 원본 → C3 경고 배너, [세 항목 모두 …]로 원본 맞춤, 업무구분 체크 해제 → bizCds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { pinia, router, calls } = await setup('/projects/new', SA, [], {
      'GET /api/v1/projects/copy-sources': () => json(200, SOURCES),
      'POST /api/v1/projects/copy-preview': () => preview(true),
    });
    const w = mount(ProjectNewPage, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(w.find('[data-testid="c3-warning"]').exists()).toBe(false);
    const domainsRow = w.get('tr[data-item="domains"]');
    await domainsRow
      .findAll('button')
      .find((b) => b.text() === '다른 프로젝트')!
      .trigger('click');
    expect(w.get('[data-testid="c3-warning"]').text()).toContain('연구관리시스템(이관)');
    expect(domainsRow.text()).toContain('원본 다름');
    // 업무구분 RP만 해제
    const rp = w
      .get('tr[data-item="bizAreas"]')
      .findAll('label.check')
      .find((l) => l.text().includes('RP'))!;
    await rp.get('input').setValue(false);
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();
    const imp = bodyOf(calls, 'POST', '/api/v1/projects/copy-preview').imports;
    expect(imp.domains).toEqual({ source: 'PROJECT', sourceKey: 'RMS' });
    expect(imp.bizAreas.bizCds).toEqual(['AC', 'BD', 'CT', 'GW', 'PS']);
    await button(w, '세 항목 모두').trigger('click');
    expect(w.find('[data-testid="c3-warning"]').exists()).toBe(false);
  });
});

describe('ProjectSettingsPage(12)', () => {
  const settings = (status = 'ACTIVE') => ({
    projectKey: 'RMS',
    projectNm: '연구관리시스템(이관)',
    description: null,
    kind: 'PROJECT',
    status,
    defaultDialect: 'POSTGRESQL',
    includeDefaultCols: true,
    defaultColSetId: 3,
    defaultColSets: [{ setId: 3, setNm: '기본', isDefault: true, columns: [] }],
    copiedFrom: { key: 'STDV1', nm: 'TermFlow 기본 표준 v1' },
    createdAt: '2026-09-28T10:00:00',
    createdBy: 'MIGRATION',
  });
  const member = (userId: number, loginId: string, role: string) => ({
    userId,
    loginId,
    userNm: loginId,
    role,
    isSysAdmin: false,
    isActive: true,
    addedAt: '2026-09-28T10:00:00',
    lastLoginAt: null,
  });

  it('PA: 멤버 검색 → 추가, 마지막 관리자 강등 409는 안내 후 원복, 보관 버튼 비활성 + 요청 안내', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let list = [member(2, 'pa', 'ADMIN')];
    const { pinia, router, calls } = await setup(
      '/projects/RMS/settings?tab=members',
      PA,
      [proj('RMS', 'ADMIN')],
      {
        'GET /api/v1/projects/RMS/settings': () => json(200, settings()),
        'GET /api/v1/projects/RMS/copy-log': () => json(200, []),
        'GET /api/v1/projects/RMS/members': () => json(200, list),
        'GET /api/v1/projects/RMS/member-candidates': () =>
          json(200, [
            { userId: 5, loginId: 'jeongms', userNm: '정민수', isSysAdmin: false, isMember: false },
            { userId: 2, loginId: 'pa', userNm: 'pa', isSysAdmin: false, isMember: true },
          ]),
        'POST /api/v1/projects/RMS/members': () => (
          (list = [...list, member(5, 'jeongms', 'EDITOR')]),
          json(201, member(5, 'jeongms', 'EDITOR'))
        ),
        'PUT /api/v1/projects/RMS/members/2': () =>
          problem(409, 'conflict', 'E_LAST_PROJECT_ADMIN'),
      },
    );
    const w = mount(ProjectSettingsPage, { global: { plugins: [pinia, router] } });
    await flushPromises();
    await w.get('input[aria-label="사용자 검색"]').setValue('정민');
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();
    const opts = w.findAll('[role="option"]');
    expect(opts[1]!.attributes('disabled')).toBeDefined(); // 이미 멤버
    await opts[0]!.trigger('click');
    await button(w, '추가').trigger('click');
    await flushPromises();
    expect(bodyOf(calls, 'POST', '/api/v1/projects/RMS/members')).toEqual({
      userId: 5,
      role: 'EDITOR',
    });
    expect(w.text()).toContain('jeongms');
    const sel = w.get('select[aria-label="pa 역할"]');
    await sel.setValue('EDITOR');
    await flushPromises();
    expect((sel.element as HTMLSelectElement).value).toBe('ADMIN');
    expect(useToastText()).toContain('프로젝트 관리자는 최소 1명이어야 합니다');

    await w
      .findAll('[role="tab"]')
      .find((t) => t.text().includes('기본 정보'))!
      .trigger('click');
    expect(button(w, '보관').attributes('disabled')).toBeDefined();
    expect(w.get('[data-testid="archive-hint"]').text()).toContain('시스템 관리자에게 요청');
    expect((w.get('#s-key').element as HTMLInputElement).disabled).toBe(true);
  });

  it('SA: 보관된 프로젝트 삭제는 키를 정확히 입력해야 버튼 활성', async () => {
    const { pinia, router, calls } = await setup('/projects/RMS/settings', SA, [proj('RMS')], {
      'GET /api/v1/projects/RMS/settings': () => json(200, settings('ARCHIVED')),
      'GET /api/v1/projects/RMS/copy-log': () => json(200, []),
      'GET /api/v1/projects/RMS/members': () => json(200, []),
      'DELETE /api/v1/admin/projects/RMS': () => new Response(null, { status: 204 }),
      'GET /api/v1/admin/projects': () => json(200, []),
    });
    const w = mount(ProjectSettingsPage, {
      global: { plugins: [pinia, router] },
      attachTo: document.body,
    });
    await flushPromises();
    expect(w.text()).toContain('읽기 전용');
    await button(w, '프로젝트 삭제').trigger('click');
    const confirm = () => w.findAll('.modal button').find((b) => b.text().includes('삭제'))!;
    expect(confirm().attributes('disabled')).toBeDefined();
    await w.get('input[aria-label="확인용 키"]').setValue('RMS');
    expect(confirm().attributes('disabled')).toBeUndefined();
    await confirm().trigger('click');
    await flushPromises();
    expect(bodyOf(calls, 'DELETE', '/api/v1/admin/projects/RMS')).toEqual({ confirmKey: 'RMS' });
    await untilRoute(router, '/admin/projects');
    w.unmount();
  });
});

function useToastText(): string {
  return useToastStore()
    .items.map((t) => t.text)
    .join(' | ');
}

describe('BizAreasPage(15)', () => {
  const rows = [
    {
      bizAreaId: 1,
      bizCd: 'RP',
      bizNm: '연구과제',
      tablePrefix: 'RP_',
      sortNo: 1,
      useYn: true,
      description: null,
      tableCnt: 33,
      codeClsCnt: 28,
      locked: true,
      origin: { projectKey: 'STDV1', projectNm: 'TermFlow 기본 표준 v1' },
    },
    {
      bizAreaId: 2,
      bizCd: 'PS',
      bizNm: '인사',
      tablePrefix: 'PS_',
      sortNo: 2,
      useYn: true,
      description: null,
      tableCnt: 0,
      codeClsCnt: 52,
      locked: false,
      origin: null,
    },
  ];
  it('잠긴 행: 자물쇠 + 툴팁·사용 토글 비활성, 추가 행 접두어 기본값, 삭제 확인에 코드구분·코드 건수', async () => {
    const { pinia, router, calls } = await setup(
      '/projects/RMS/biz-areas',
      PA,
      [proj('RMS', 'ADMIN')],
      {
        'GET /api/v1/projects/RMS/biz-areas': () => json(200, rows),
        'POST /api/v1/projects/RMS/biz-areas': () =>
          json(201, { ...rows[1], bizAreaId: 3, bizCd: 'CM' }),
        'GET /api/v1/projects/RMS/biz-areas/2/delete-preview': () =>
          json(200, { tableCnt: 0, codeClsCnt: 52, codeCnt: 381, referencingColumnCnt: 2 }),
        'DELETE /api/v1/projects/RMS/biz-areas/2': () =>
          json(200, { deletedCodeCls: 52, deletedCodes: 381, affectedColumns: 2 }),
      },
    );
    const w = mount(BizAreasPage, {
      global: { plugins: [pinia, router] },
      attachTo: document.body,
    });
    await flushPromises();
    const lock = w.get('[role="img"]');
    expect(lock.attributes('title')).toBe('테이블 33개가 있어 변경할 수 없습니다');
    expect(w.get('input[aria-label="RP 사용"]').attributes('disabled')).toBeDefined();
    expect(w.get('input[aria-label="PS 사용"]').attributes('disabled')).toBeUndefined();

    await button(w, '업무구분 추가').trigger('click');
    await w.get('input[aria-label="코드"]').setValue('cm');
    await w.get('input[aria-label="이름"]').setValue('공통');
    expect((w.get('input[aria-label="테이블 접두어"]').element as HTMLInputElement).value).toBe(
      'CM_',
    );
    expect(w.text()).toContain('코드 CM 사용 가능');
    await w
      .findAll('button')
      .find((b) => b.text().startsWith('추가'))!
      .trigger('click');
    await flushPromises();
    expect(bodyOf(calls, 'POST', '/api/v1/projects/RMS/biz-areas')).toMatchObject({
      bizCd: 'CM',
      bizNm: '공통',
      tablePrefix: 'CM_',
      useYn: true,
    });

    await w.get('button[aria-label="PS 행 메뉴"]').trigger('click');
    await w
      .findAll('.dropdown-menu.is-open .dropdown-item')
      .find((b) => b.text() === '삭제')!
      .trigger('click');
    await flushPromises();
    expect(w.get('[data-testid="delete-counts"]').text()).toContain('코드구분 52개 · 코드 381개');
    expect(w.get('.modal').text()).toContain('컬럼 2개');
    await w
      .findAll('.modal button')
      .find((b) => b.text() === '삭제')!
      .trigger('click');
    await flushPromises();
    expect(
      calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/projects/RMS/biz-areas/2'),
    ).toBe(true);
    w.unmount();
  });
});

describe('AdminProjectsPage · AdminTemplatesPage', () => {
  const item = (key: string, status: 'ACTIVE' | 'ARCHIVED') => ({
    key,
    nm: `${key} 이름`,
    description: null,
    status,
    memberCnt: 1,
    tableCnt: 0,
    bizCds: ['RP'],
    copiedFrom: null,
    lastChangedAt: null,
    createdAt: '2026-09-28T10:00:00',
    createdBy: 'admin',
  });
  it('프로젝트: ACTIVE 행 삭제 비활성(보관 후), 보관 → PUT status', async () => {
    const { pinia, router, calls } = await setup('/admin/projects', SA, [], {
      'GET /api/v1/admin/projects': () =>
        json(200, [item('RMS', 'ACTIVE'), item('OLD', 'ARCHIVED')]),
      'PUT /api/v1/admin/projects/RMS/status': () => json(200, item('RMS', 'ARCHIVED')),
    });
    const w = mount(AdminProjectsPage, {
      global: { plugins: [pinia, router] },
      attachTo: document.body,
    });
    await flushPromises();
    await w.get('button[aria-label="RMS 행 메뉴"]').trigger('click');
    const del = w.findAll('.dropdown-item').find((b) => b.text().includes('삭제 (보관 후)'))!;
    expect(del.attributes('disabled')).toBeDefined();
    await w
      .findAll('.dropdown-item')
      .find((b) => b.text() === '보관')!
      .trigger('click');
    await flushPromises();
    expect(bodyOf(calls, 'PUT', '/api/v1/admin/projects/RMS/status')).toEqual({
      status: 'ARCHIVED',
    });
    w.unmount();
  });

  it('템플릿: 게시 인라인 폼 → POST(승인 용어만 기본), 사용 중 템플릿은 삭제 비활성', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const tpl = {
      key: 'STDV1',
      nm: 'TermFlow 기본 표준 v1',
      description: null,
      status: 'ACTIVE',
      counts,
      derivedCnt: 1,
      publishedFrom: null,
      createdAt: '2026-09-28T10:00:00',
      createdBy: 'MIGRATION',
    };
    const { pinia, router, calls } = await setup('/admin/templates', SA, [], {
      'GET /api/v1/admin/templates': () => json(200, [tpl]),
      'GET /api/v1/admin/projects': () => json(200, [item('RMS', 'ACTIVE')]),
      'GET /api/v1/projects/check-key': () => json(200, { available: true }),
      'POST /api/v1/admin/templates': () =>
        json(201, { projectKey: 'TPLRND', elapsedMs: 900, items: [] }),
    });
    const w = mount(AdminTemplatesPage, {
      global: { plugins: [pinia, router] },
      attachTo: document.body,
    });
    await flushPromises();
    expect(w.text()).toContain('4,587');
    await w.get('button[aria-label="STDV1 행 메뉴"]').trigger('click');
    expect(
      w
        .findAll('.dropdown-item')
        .find((b) => b.text().includes('삭제'))!
        .attributes('disabled'),
    ).toBeDefined();
    await button(w, '프로젝트에서 템플릿 게시').trigger('click');
    await w.get('#tp-name').setValue('연구기관 표준 v1');
    await w.get('#tp-key').setValue('tplrnd');
    await vi.advanceTimersByTimeAsync(400);
    await flushPromises();
    await w
      .findAll('button')
      .find((b) => b.text() === '게시')!
      .trigger('click');
    await flushPromises();
    expect(bodyOf(calls, 'POST', '/api/v1/admin/templates')).toEqual({
      sourceProjectKey: 'RMS',
      projectKey: 'TPLRND',
      projectNm: '연구기관 표준 v1',
      description: null,
      approvedOnly: true,
    });
    w.unmount();
  });
});

describe('사이드바·템플릿 배너(§10.2)', () => {
  it('단계 5 메뉴 활성화(업무구분·설정·시스템 프로젝트·템플릿), 프로젝트 전환은 같은 하위 경로 유지', async () => {
    const { pinia, router } = await setup(
      '/projects/RMS/settings',
      SA,
      [proj('RMS'), proj('HRM26'), proj('STDV1', 'ADMIN', 'TEMPLATE')],
      {},
    );
    const w = mount(AppShell, {
      global: { plugins: [pinia, router] },
      slots: { default: '<p>본문</p>' },
    });
    await flushPromises();
    const hrefs = w.findAll('a.nav-item').map((a) => a.attributes('href'));
    expect(hrefs).toEqual(
      expect.arrayContaining([
        '/projects/RMS',
        '/projects/RMS/biz-areas',
        '/projects/RMS/settings',
        '/admin/projects',
        '/admin/templates',
      ]),
    );
    const switchTo = w
      .findAll('.project-switcher .dropdown-item')
      .find((a) => a.text().includes('HRM26'))!;
    expect(switchTo.attributes('href')).toBe('/projects/HRM26/settings');
    // 템플릿은 전환 목록에 없다
    expect(
      w.findAll('.project-switcher .dropdown-item').some((a) => a.text().includes('STDV1')),
    ).toBe(false);
    expect(w.text()).not.toContain('템플릿 편집 중');
  });

  it('SA가 템플릿을 열면 배너 + [설계] 그룹 숨김', async () => {
    const { pinia, router } = await setup(
      '/projects/STDV1/biz-areas',
      SA,
      [proj('STDV1', 'ADMIN', 'TEMPLATE')],
      {},
    );
    const w = mount(AppShell, {
      global: { plugins: [pinia, router] },
      slots: { default: '<p>본문</p>' },
    });
    await flushPromises();
    expect(w.text()).toContain('템플릿 편집 중');
    expect(w.findAll('.nav-title').map((t) => t.text())).not.toContain('설계');
    expect(w.findAll('.nav-title').map((t) => t.text())).toContain('프로젝트');
  });
});
