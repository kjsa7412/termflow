import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { Api, PROJECT } from './helpers.js';

/**
 * T10.7 접근성 최소 기준(설계서 §10.6): 주요 화면을 axe(WCAG 2.x A·AA 규칙)로 검사해 critical·serious 위반 0.
 * 대비 4.5:1은 axe `color-contrast` 규칙이 판정한다. 포커스 트랩·키보드 흐름은 아래 두 테스트와 web 화면 테스트가 맡는다.
 */
const P = `/projects/${PROJECT}`;

async function scan(page: Page, name: string) {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const bad = r.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  const detail = (n: (typeof bad)[number]['nodes'][number]) => {
    const d = n.any[0]?.data as
      | {
          fgColor?: string;
          bgColor?: string;
          contrastRatio?: number;
          expectedContrastRatio?: string;
        }
      | undefined;
    return d?.contrastRatio
      ? `${n.target.join(' ')} ${d.fgColor}/${d.bgColor} ${d.contrastRatio}:${d.expectedContrastRatio}`
      : n.target.join(' ');
  };
  const summary = bad.map(
    (v) =>
      `${v.id}(${v.impact}) ×${v.nodes.length}: ${v.nodes.slice(0, 6).map(detail).join(' | ')}`,
  );
  test.info().annotations.push({
    type: `axe ${name}`,
    description: `위반 critical·serious ${bad.length}종, 전체 ${r.violations.length}종(${r.violations.map((v) => `${v.id}:${v.impact}`).join(', ') || '없음'})`,
  });
  expect(summary, `${name} axe 위반`).toEqual([]);
}

let tableId = 0;
test.beforeAll(async ({ baseURL }, info) => {
  const api = await Api.open(baseURL!, info.project.use.storageState as string);
  tableId = (await api.get<{ items: { tableId: number }[] }>(`/api/v1${P}/tables?size=1`)).items[0]!
    .tableId;
  await api.dispose();
});

const SCREENS: [string, string, string][] = [
  ['프로젝트 목록(02)', '/projects', 'main'],
  ['프로젝트 홈(03)', P, 'main'],
  ['용어(04)', `${P}/standards/terms`, 'tbody tr'],
  ['일괄 등록(04b)', `${P}/standards/terms/import`, '[data-testid="dropzone"]'],
  ['도메인분류(05)', `${P}/standards/domain-classes`, 'tbody tr'],
  ['도메인(06)', `${P}/standards/domains`, 'tbody tr'],
  ['코드(07)', `${P}/standards/codes`, 'main'],
  ['기본컬럼', `${P}/standards/default-columns`, 'main'],
  ['테이블 목록(09)', `${P}/tables`, 'tbody tr'],
  ['DDL 내보내기(10)', `${P}/export`, 'main'],
  ['승인 큐(11)', `${P}/standards/approvals`, 'main'],
  ['업무구분(12)', `${P}/biz-areas`, 'tbody tr'],
  ['프로젝트 설정(13)', `${P}/settings`, 'main'],
  ['사용자 관리(15)', '/admin/users', 'tbody tr'],
  ['템플릿(16)', '/admin/templates', 'main'],
  ['시스템 프로젝트', '/admin/projects', 'main'],
  ['내 계정', '/me', 'main'],
  ['새 프로젝트(02b)', '/projects/new', 'main'],
  ['404', '/no-such-page', 'main'],
];

for (const [name, url, ready] of SCREENS) {
  test(`axe — ${name}`, async ({ page }) => {
    await page.goto(url);
    await page.locator(ready).first().waitFor();
    await page.waitForLoadState('networkidle');
    await scan(page, name);
  });
}

test('axe — 테이블 편집기(08, 기존 테이블 + DDL 패널)', async ({ page }) => {
  await page.goto(`${P}/tables/${tableId}`);
  await page.getByTestId('column-grid').waitFor();
  await page.getByTestId('ddl-code').waitFor();
  await scan(page, '편집기');
});

test('axe — 로그인(01, 비로그인)', async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.locator('#login-id').waitFor();
  await scan(page, '로그인');
  await ctx.close();
});

test('키보드: 삭제 확인 모달(dialog) 포커스 트랩 — Tab이 모달 밖으로 나가지 않고 Esc로 닫힌다', async ({
  page,
}) => {
  await page.goto(`${P}/tables`);
  await page.locator('tbody tr').first().waitFor();
  await page
    .getByRole('button', { name: /행 메뉴/ })
    .first()
    .click();
  await page.getByRole('menuitem', { name: /삭제/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await scan(page, '삭제 확인 모달');
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    const inside = await dialog.evaluate((d) => d.contains(document.activeElement));
    expect(inside, `Tab ${i + 1}회 후 포커스가 모달 안`).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('키보드: 자동완성 listbox — 포커스는 입력 셀, ↑↓로 aria-selected·aria-activedescendant 이동, Esc로 닫힘 + axe', async ({
  page,
}) => {
  await page.goto(`${P}/tables/new`);
  await page.getByTestId('column-grid').waitFor();
  const logical = page.locator('tbody tr[data-row="1"] [data-field="logicalNm"]');
  await logical.fill('접수일');
  await logical.press('Enter');
  const lb = page.getByTestId('ac-listbox');
  await expect(lb).toBeVisible();
  await expect(lb).toHaveAttribute('role', 'listbox');
  await expect(logical).toBeFocused();
  await logical.press('ArrowDown');
  const selected = lb.locator('[role="option"][aria-selected="true"]');
  await expect(selected).toHaveCount(1);
  const selId = await selected.getAttribute('id');
  expect(selId).toBeTruthy();
  await expect(logical).toHaveAttribute('aria-activedescendant', selId!);
  await scan(page, '자동완성 listbox');
  await logical.press('Escape');
  await expect(lb).toBeHidden();
  await expect(logical).toBeFocused();
});

test('키보드: 포커스 링 — Tab 포커스 요소에 보이는 outline/box-shadow', async ({ page }) => {
  await page.goto(`${P}/standards/terms`);
  await page.locator('tbody tr').first().waitFor();
  const seen: string[] = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    const style = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      const ring =
        (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none';
      return `${el.tagName.toLowerCase()}:${ring ? 'ring' : 'none'}`;
    });
    if (style) seen.push(style);
  }
  expect(seen.length).toBeGreaterThan(0);
  expect(
    seen.filter((s) => s.endsWith(':none')),
    seen.join(', '),
  ).toEqual([]);
});
