import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/**
 * 소개 사이트 검수(T12.7): 페이지 다섯 × 데스크톱(1280)·모바일(375) — 가로 스크롤 없음, 콘솔 오류 없음,
 * 주소별 제목, 「직접 해 보기」 판정. 산출 그림은 `e2e/test-results/site-review/`(gitignore)에서 사람이 넘겨 본다.
 *   SITE_URL=http://localhost:5175 pnpm -C e2e exec playwright test -c site-review.config.ts
 */
test.skip(!process.env['SITE_REVIEW'], 'site-review.config.ts로 실행');

const OUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test-results',
  'site-review',
);
mkdirSync(OUT, { recursive: true });
const PAGES = ['/', '/features', '/screens', '/install', '/releases', '/no-such'];
const SIZES = [
  { name: 'desktop', width: 1280, height: 860 },
  { name: 'mobile', width: 375, height: 812 },
];

for (const s of SIZES) {
  for (const p of PAGES) {
    test(`${s.name} ${p}`, async ({ page }) => {
      const errors: string[] = [];
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      page.on('pageerror', (e) => errors.push(e.message));
      await page.setViewportSize({ width: s.width, height: s.height });
      await page.goto(p);
      await page.locator('h1').first().waitFor();
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(overflow, '가로 스크롤').toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
      const name = `${s.name}${p === '/' ? '-home' : p.replace(/\//g, '-')}`;
      await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
    });
  }
}

test('어두운 테마 · 직접 해 보기 · 라이트박스', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('/');
  await expect(page).toHaveTitle(/TermFlow — 용어에서 DDL까지/);
  const out = page.locator('.try__out');
  for (const [ex, verdict] of [
    ['교육과정번호', '표준'],
    ['교육신청일자', '조합'],
    ['신청일', '비슷한 후보'],
    ['교육구분코드', '코드'],
    ['강의실번호', '미등록'],
  ] as const) {
    await page.getByRole('button', { name: ex, exact: true }).click();
    await expect(out.locator('.badge')).toHaveText(verdict);
  }
  await page.locator('#try-logical').fill('사원번호');
  await expect(out.locator('.badge')).toHaveText('표준');
  await page.locator('.try').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, 'dark-home-try.png') });
  await page.locator('.shot__frame').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await page.screenshot({ path: path.join(OUT, 'dark-lightbox.png') });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // 라우터: 상단 바 링크 → 제목·주소
  await page
    .getByRole('navigation', { name: '사이트' })
    .getByRole('link', { name: '설치' })
    .click();
  await expect(page).toHaveURL(/\/install$/);
  await expect(page).toHaveTitle('설치 · TermFlow');
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
});
