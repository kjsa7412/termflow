import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { Api, PROJECT } from './helpers.js';

/**
 * T10.5 목업 대비 화면 검수 자료: 목업 18종(docs/mockups) × 구현 화면(dev 서버, RMS)을 같은 크기로 찍고 나란히 붙인다.
 * `E2E_SHOTS=1 pnpm -C e2e exec playwright test mockup-shots --project=chrome` → `e2e/shots/NN_*.png`(gitignore).
 * 판정(의도·결함)은 `docs/수용_테스트_결과.md` 목업 검수표에 적는다. 데이터는 바꾸지 않는다(충돌 모달은 응답 가로채기).
 */
test.skip(!process.env['E2E_SHOTS'], 'E2E_SHOTS=1일 때만(검수 자료 생성)');
test.use({ viewport: { width: 1440, height: 900 } });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOCK = path.join(ROOT, 'docs', 'mockups');
const OUT = path.join(ROOT, 'e2e', 'shots');
const P = `/projects/${PROJECT}`;

let tableId = 0;
test.beforeAll(async ({ baseURL }, info) => {
  mkdirSync(OUT, { recursive: true });
  const api = await Api.open(baseURL!, info.project.use.storageState as string);
  // 목업 08·14는 RP_RSCH_PRJ_MAST(연구과제마스터)
  const page = await api.get<{ items: { tableId: number; tableNm: string }[] }>(
    `/api/v1${P}/tables?q=RP_RSCH_PRJ_MAST&size=5`,
  );
  tableId = (page.items.find((t) => t.tableNm === 'RP_RSCH_PRJ_MAST') ?? page.items[0])!.tableId;
  await api.dispose();
});

async function sideBySide(page: Page, name: string, mock: Buffer, impl: Buffer): Promise<void> {
  writeFileSync(path.join(OUT, `${name}_mockup.png`), mock);
  writeFileSync(path.join(OUT, `${name}_impl.png`), impl);
  const b64 = (b: Buffer) => `data:image/png;base64,${b.toString('base64')}`;
  const view = await page.context().newPage();
  await view.setViewportSize({ width: 1600, height: 560 });
  await view.setContent(
    `<body style="margin:0;font:13px sans-serif;background:#333;color:#fff">
      <div style="display:flex;gap:0">
        <figure style="margin:0;width:800px"><figcaption style="padding:4px 8px">목업 ${name}</figcaption><img style="width:800px" src="${b64(mock)}"></figure>
        <figure style="margin:0;width:800px"><figcaption style="padding:4px 8px">구현 ${name}</figcaption><img style="width:800px" src="${b64(impl)}"></figure>
      </div></body>`,
  );
  await view.screenshot({ path: path.join(OUT, `${name}.png`) });
  await view.close();
}

async function mockShot(page: Page, file: string): Promise<Buffer> {
  const m = await page.context().newPage();
  await m.goto(pathToFileURL(path.join(MOCK, file)).href);
  await m.waitForLoadState('load');
  const b = await m.screenshot();
  await m.close();
  return b;
}

async function settle(page: Page, ready: string): Promise<void> {
  await page.locator(ready).first().waitFor();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
}

const PAIRS: [string, string, string, string][] = [
  ['02_projects', '02_projects.html', '/projects', 'main'],
  ['02b_project_new', '02b_project_new.html', '/projects/new', 'main'],
  ['03_dashboard', '03_dashboard.html', P, 'main'],
  ['04_terms', '04_terms.html', `${P}/standards/terms`, 'tbody tr'],
  [
    '04b_terms_import',
    '04b_terms_import.html',
    `${P}/standards/terms/import`,
    '[data-testid="dropzone"]',
  ],
  ['05_domain_classes', '05_domain_classes.html', `${P}/standards/domain-classes`, 'tbody tr'],
  ['06_domains', '06_domains.html', `${P}/standards/domains`, 'tbody tr'],
  ['07_codes', '07_codes.html', `${P}/standards/codes`, 'main'],
  ['09_tables', '09_tables.html', `${P}/tables`, 'tbody tr'],
  ['11_approvals', '11_approvals.html', `${P}/standards/approvals`, 'main'],
  ['12_project_settings', '12_project_settings.html', `${P}/settings`, 'main'],
  ['13_users', '13_users.html', '/admin/users', 'tbody tr'],
  ['15_biz_areas', '15_biz_areas.html', `${P}/biz-areas`, 'tbody tr'],
  ['16_templates', '16_templates.html', '/admin/templates', 'main'],
];

for (const [name, file, url, ready] of PAIRS) {
  test(`목업 ${name}`, async ({ page }) => {
    const mock = await mockShot(page, file);
    await page.goto(url);
    await settle(page, ready);
    await sideBySide(page, name, mock, await page.screenshot());
  });
}

test('목업 01_login', async ({ browser, page }) => {
  const mock = await mockShot(page, '01_login.html');
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 1440, height: 900 });
  await p.goto('/login');
  await settle(p, '#login-id');
  const impl = await p.screenshot();
  await ctx.close();
  await sideBySide(page, '01_login', mock, impl);
});

test('목업 08_table_editor', async ({ page }) => {
  const mock = await mockShot(page, '08_table_editor.html');
  await page.goto(`${P}/tables/${tableId}`);
  await settle(page, '[data-testid="ddl-code"]');
  await sideBySide(page, '08_table_editor', mock, await page.screenshot());
});

test('목업 10_ddl_export', async ({ page }) => {
  const mock = await mockShot(page, '10_ddl_export.html');
  await page.goto(`${P}/tables`);
  await settle(page, 'tbody tr');
  await page.locator('input[aria-label="전체 선택"]').locator('xpath=ancestor::label[1]').click();
  await page
    .locator('[aria-label="선택 작업"]')
    .getByRole('button', { name: 'DDL 내보내기' })
    .click();
  await settle(page, '[data-testid="ddl-code"]');
  await sideBySide(page, '10_ddl_export', mock, await page.screenshot());
});

test('목업 14_conflict(409 응답 가로채기 — DB 변경 없음)', async ({ page }) => {
  const mock = await mockShot(page, '14_conflict.html');
  type Detail = {
    table: { version: number; status: string };
    columns: { colComment: string | null }[];
  };
  let detail: Detail | null = null;
  // RMS 33 테이블은 모두 FINAL — 화면 검수용으로 GET 응답만 DRAFT로 바꿔 편집 가능하게 하고, PUT은 409로 답한다
  await page.route(`**/api/v1${P}/tables/${tableId}`, async (route) => {
    if (route.request().method() === 'GET') {
      const res = await route.fetch();
      const d = (await res.json()) as Detail;
      detail = { ...d, table: { ...d.table, status: 'DRAFT' } };
      return route.fulfill({ response: res, json: detail });
    }
    if (route.request().method() !== 'PUT') return route.fallback();
    const d = detail!;
    const cols = d.columns.map((c, i) =>
      i === 1 ? { ...c, colComment: '다른 사용자가 고친 코멘트' } : c,
    );
    await route.fulfill({
      status: 409,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'https://termflow.local/problems/version-conflict',
        title: '버전 충돌',
        status: 409,
        detail: '편집자1이(가) 10:42:10에 저장했습니다.',
        code: 'E_VERSION_CONFLICT',
        yourVersion: d.table.version,
        currentVersion: d.table.version + 1,
        savedBy: '편집자1',
        savedAt: '2026-09-30T10:42:10',
        current: { table: { ...d.table, version: d.table.version + 1 }, columns: cols },
      }),
    });
  });
  await page.goto(`${P}/tables/${tableId}`);
  await settle(page, '[data-testid="ddl-code"]');
  const comment = page.locator('#ed-desc');
  await comment.fill('내가 고친 설명(검수용, 저장 안 함)');
  await page.getByTestId('save').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.waitForTimeout(300);
  await sideBySide(page, '14_conflict', mock, await page.screenshot());
  // 편집본은 저장하지 않는다(PUT은 가로챘고, 임시저장은 이 브라우저 컨텍스트에만 남는다)
});

const EXTRA: [string, string, string][] = [
  ['x_default_columns', `${P}/standards/default-columns`, 'main'],
  ['x_me', '/me', 'main'],
  ['x_admin_projects', '/admin/projects', 'main'],
  ['x_404', '/no-such-page', 'main'],
];
for (const [name, url, ready] of EXTRA) {
  test(`목업 없는 화면 ${name}`, async ({ page }) => {
    await page.goto(url);
    await settle(page, ready);
    writeFileSync(path.join(OUT, `${name}.png`), await page.screenshot());
  });
}
