import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { expect, test } from '@playwright/test';
import { PROJECT, checkLabel } from './helpers.js';

/**
 * S3 다중 브라우저 E2E(단계 7에서 미룬 .sql·.zip 다운로드·클립보드 복사): 테이블 목록 전체 선택 → [DDL 내보내기](이동 1)
 * → [다운로드 .sql](클릭 3 / 이동 1) → 형식 메뉴 .zip(테이블별 파일, 업무구분 폴더) → [복사](클립보드).
 */
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test('S3 다중 — 전체 선택 → 내보내기 → .sql·.zip 다운로드·복사', async ({ page }) => {
  await page.goto(`/projects/${PROJECT}/tables`);
  const all = checkLabel(page, 'input[aria-label="전체 선택"]');
  await expect(all).toBeVisible();
  await expect(page.locator('tbody input[type="checkbox"]').first()).toBeAttached();
  let clicks = 0;
  await all.click();
  clicks++;
  await expect(page.getByRole('checkbox', { name: '전체 선택' })).toBeChecked();
  const count = Number(await page.getByTestId('selected-count').innerText());
  expect(count).toBeGreaterThanOrEqual(3);
  await page
    .locator('[aria-label="선택 작업"]')
    .getByRole('button', { name: 'DDL 내보내기' })
    .click();
  clicks++;
  await page.waitForURL(/\/export/);

  const primary = page.getByTestId('download-primary');
  await expect(primary).toBeEnabled();
  const [sqlDl] = await Promise.all([page.waitForEvent('download'), primary.click()]);
  clicks++;
  expect(clicks).toBe(3);
  expect(sqlDl.suggestedFilename()).toMatch(/\.sql$/);
  const sql = readFileSync((await sqlDl.path())!, 'utf8');
  expect(sql.match(/^CREATE TABLE /gm)?.length).toBe(count);

  await page.getByRole('button', { name: '다운로드 형식 선택' }).click();
  const [zipDl] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: /\.zip/ }).click(),
  ]);
  expect(zipDl.suggestedFilename()).toMatch(/\.zip$/);
  const zip = await JSZip.loadAsync(readFileSync((await zipDl.path())!));
  const sqlFiles = Object.keys(zip.files).filter((f) =>
    /^[A-Z0-9]+\/\d{2}_[A-Z0-9_]+\.sql$/.test(f),
  );
  expect(sqlFiles).toHaveLength(count);
  const first = await zip.file(sqlFiles[0]!)!.async('string');
  expect(first).toMatch(/CREATE TABLE /);

  await page.getByRole('button', { name: '복사', exact: true }).first().click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip.match(/^CREATE TABLE /gm)?.length).toBe(count);
  test.info().annotations.push({
    type: 'S3 다중',
    description: `클릭 ${clicks} · 이동 1 · 테이블 ${count}`,
  });
});
