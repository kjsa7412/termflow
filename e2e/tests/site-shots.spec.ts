import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { DEMO } from './demo-seed.js';

/**
 * 소개 사이트·설명서 그림(T12.6): 데모 인스턴스의 가상 프로젝트 EDU 화면 → `docs/img/screens/NN-이름.png`(커밋).
 * `site-shots.config.ts`로만 돈다(일반 E2E에서는 건너뜀). 데이터는 바꾸지 않는다(새 테이블 화면은 저장하지 않고 닫는다).
 */
test.skip(!process.env['SITE_SHOTS'], 'site-shots.config.ts로 실행(데모 인스턴스)');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'docs', 'img', 'screens');
const P = `/projects/${DEMO}`;
const A = `/api/v1${P}`;
mkdirSync(OUT, { recursive: true });

async function settle(page: Page, ready: string): Promise<void> {
  await page.locator(ready).first().waitFor();
  await page.waitForLoadState('networkidle');
  // 깜빡이는 입력 커서·스켈레톤이 그림에 남지 않게
  await page.addStyleTag({ content: '*{caret-color:transparent !important}' });
  await page.waitForTimeout(400);
}
const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(OUT, `${name}.png`), animations: 'disabled' });

async function tableId(page: Page, logical: string): Promise<number> {
  const r = await page.request.get(`${A}/tables?q=${encodeURIComponent(logical)}&size=20`);
  const body = (await r.json()) as {
    items: { tableId: number; tableLogicalNm?: string; logicalNm?: string }[];
  };
  const t = body.items.find((x) => (x.tableLogicalNm ?? x.logicalNm) === logical) ?? body.items[0];
  if (!t) throw new Error(`테이블 없음: ${logical}`);
  return t.tableId;
}
async function bizId(page: Page, bizCd: string): Promise<number> {
  const list = (await (await page.request.get(`${A}/biz-areas`)).json()) as {
    bizAreaId: number;
    bizCd: string;
  }[];
  return list.find((b) => b.bizCd === bizCd)!.bizAreaId;
}

test('01 로그인', async ({ browser }) => {
  const ctx = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: { width: 1440, height: 900 },
  });
  const p = await ctx.newPage();
  await p.goto('/login');
  await settle(p, '#login-id');
  await shot(p, '01-login');
  await ctx.close();
});

const PAGES: [string, string, string][] = [
  ['02-projects', '/projects', 'main .card'],
  ['03-project-home', P, 'main'],
  // 표준 사전 목록은 일반 낱말이 보이는 검색어로(전체 첫 쪽은 숫자·약어 위주)
  ['04-terms', `${P}/standards/terms?q=${encodeURIComponent('일')}`, 'tbody tr'],
  ['05-domains', `${P}/standards/domains?q=${encodeURIComponent('교육')}`, 'tbody tr'],
  ['06-codes', `${P}/standards/codes`, 'main'],
  ['12-approvals', `${P}/standards/approvals`, 'tbody tr'],
  ['13-project-new', '/projects/new', 'main'],
  ['14-project-settings', `${P}/settings`, 'main'],
  ['15-users', '/admin/users', 'tbody tr'],
  ['16-biz-areas', `${P}/biz-areas`, 'tbody tr'],
  ['17-templates', '/admin/templates', 'main'],
  ['18-manual', `/manual/${encodeURIComponent('사용자_가이드')}`, '[data-testid="manual-body"] h1'],
];
for (const [name, url, ready] of PAGES) {
  test(name, async ({ page }) => {
    await page.goto(url);
    await settle(page, ready);
    await shot(page, name);
  });
}

test('07 테이블 목록', async ({ page }) => {
  await page.goto(`${P}/tables?bizAreaId=${await bizId(page, 'ED')}`);
  await settle(page, 'tbody tr');
  await shot(page, '07-tables');
});

test('08 테이블 편집기 + DDL 패널', async ({ page }) => {
  await page.goto(`${P}/tables/${await tableId(page, '교육신청이력')}`);
  await settle(page, '[data-testid="ddl-code"]');
  await shot(page, '08-editor');
});

test('09 자동완성 — 비슷한 도메인 목록', async ({ page }) => {
  await page.goto(`${P}/tables/new?bizAreaId=${await bizId(page, 'ED')}`);
  await expect(page.getByTestId('column-grid')).toBeVisible();
  await page.locator('#ed-logical').fill('교육설문응답');
  await page.locator('#ed-logical').press('Tab');
  const cell = (row: number, field: string) =>
    page.locator(`tbody tr[data-row="${row}"] [data-field="${field}"]`);
  for (const [i, nm] of ['교육과정번호', '사원번호'].entries()) {
    await cell(i + 1, 'logicalNm').fill(nm);
    await cell(i + 1, 'logicalNm').press('Enter');
    await expect(cell(i + 2, 'logicalNm')).toBeFocused();
  }
  await cell(3, 'logicalNm').fill('신청일');
  await cell(3, 'logicalNm').press('Enter');
  await expect(page.getByTestId('ac-listbox')).toBeVisible();
  await cell(3, 'logicalNm').press('ArrowDown');
  await settle(page, '[data-testid="ac-listbox"]');
  await shot(page, '09-autocomplete');
});

test('10 미등록 용어 — 인라인 등록 카드', async ({ page }) => {
  await page.goto(`${P}/tables/new?bizAreaId=${await bizId(page, 'ED')}`);
  await expect(page.getByTestId('column-grid')).toBeVisible();
  await page.locator('#ed-logical').fill('강의평가결과');
  await page.locator('#ed-logical').press('Tab');
  const cell = (row: number, field: string) =>
    page.locator(`tbody tr[data-row="${row}"] [data-field="${field}"]`);
  await cell(1, 'logicalNm').fill('강의평가점수');
  await cell(1, 'logicalNm').press('Enter');
  await expect(page.getByTestId('reg-card')).toBeVisible();
  await settle(page, '[data-testid="reg-card"]');
  await shot(page, '10-inline-register');
});

test('11 DDL 내보내기', async ({ page }) => {
  await page.goto(`${P}/tables`);
  await settle(page, 'tbody tr');
  await page.locator('input[aria-label="전체 선택"]').locator('xpath=ancestor::label[1]').click();
  await page
    .locator('[aria-label="선택 작업"]')
    .getByRole('button', { name: 'DDL 내보내기' })
    .click();
  await settle(page, '[data-testid="ddl-code"]');
  await shot(page, '11-ddl-export');
});
