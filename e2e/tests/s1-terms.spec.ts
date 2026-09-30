import ExcelJS from 'exceljs';
import { expect, test } from '@playwright/test';
import { Api, PROJECT, counter, uniqueKor, uniquePhysical } from './helpers.js';

/**
 * S1 브라우저 E2E(설계서 §13.2, 검토안 S1 — 단계 6에서 미룬 브라우저 시연): 용어 단건(인라인 입력행 Enter)·
 * 엑셀 일괄(템플릿 다운로드 → 파일 선택 → 미리보기 → 적용 → 결과). 만든 용어는 테스트 끝에 지운다.
 */
let api: Api;
test.beforeAll(async ({ baseURL }, info) => {
  api = await Api.open(baseURL!, info.project.use.storageState as string);
});
test.afterAll(async () => {
  await api.dispose();
});

test('S1 단건 — 메뉴 용어 → 인라인 입력행 한글·물리약어 → Enter 등록(입력 2 · 클릭 1 · 이동 1)', async ({
  page,
}) => {
  const kor = uniqueKor();
  const phys = uniquePhysical('EA');
  await api.deleteTerms(kor);
  try {
    await page.goto(`/projects/${PROJECT}`);
    const n = counter(page);
    await n.click(page.getByRole('navigation').getByRole('link', { name: /^용어/ }).first());
    await page.waitForURL(/\/standards\/terms$/);
    n.moved();
    await n.type('input[aria-label="한글 용어"]', kor);
    await n.type('input[aria-label="물리약어"]', phys);
    await page.locator('input[aria-label="한글 용어"]').press('Enter');
    await expect(page.getByRole('status').or(page.locator('.toast')).first()).toBeVisible();
    await expect.poll(() => api.termStatus(kor)).toBe('APPROVED');
    expect(n.c).toEqual({ input: 2, click: 1, move: 1 });
    test.info().annotations.push({ type: 'S1 단건', description: JSON.stringify(n.c) });
  } finally {
    await api.deleteTerms(kor);
  }
});

test('S1 엑셀 — 일괄 등록 → 템플릿 다운로드 → 파일 선택 → 미리보기(신규·오류 색 구분) → 적용 → 결과', async ({
  page,
}, info) => {
  const kors = [uniqueKor(3), `${uniqueKor(2)}뙁뙁`];
  const physs = [uniquePhysical('EB'), uniquePhysical('EC')];
  for (const k of kors) await api.deleteTerms(k);
  try {
    await page.goto(`/projects/${PROJECT}/standards/terms`);
    const n = counter(page);
    await n.click(page.getByRole('link', { name: '일괄 등록' }));
    await page.waitForURL(/\/standards\/terms\/import$/);
    n.moved();
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      n.click(page.getByRole('button', { name: '템플릿 다운로드' })),
    ]);
    expect(dl.suggestedFilename()).toMatch(/\.xlsx$/);

    // 사용자가 엑셀에서 하는 편집(계수 밖): 예시 행을 지우고 신규 2행 + 형식 오류 1행
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile((await dl.path())!);
    const ws = wb.worksheets[0]!;
    expect(ws.getRow(1).getCell(1).value).toBe('한글용어');
    ws.spliceRows(2, ws.rowCount - 1);
    ws.addRow([kors[0], physs[0], 'E2E 일괄 등록', null]);
    ws.addRow([kors[1], physs[1], null, null]);
    ws.addRow([`${kors[0]}오류`, 'BAD-PHYS', null, null]);
    const file = info.outputPath('terms-e2e.xlsx');
    await wb.xlsx.writeFile(file);

    // 파일 선택(클릭 1 — 파일 선택 창)
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      n.click(page.getByTestId('dropzone')),
    ]);
    await chooser.setFiles(file);
    const summary = page.getByTestId('summary');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText(/신규\s*2/);
    await expect(summary).toContainText(/오류\s*1/);
    await expect(page.getByText('BAD-PHYS').first()).toBeVisible();

    await n.click(page.getByRole('button', { name: /행 적용/ }));
    await expect(page.getByText(/적용 완료 — 신규 2 · 갱신 0 · 오류 제외 1/)).toBeVisible();
    for (const k of kors) expect(await api.termStatus(k)).toBe('APPROVED');
    expect(await api.termStatus(`${kors[0]}오류`)).toBeNull();
    test.info().annotations.push({ type: 'S1 엑셀', description: JSON.stringify(n.c) });
    // 계수(첫 사용, 템플릿 다운로드 포함): 클릭 4 · 이동 1 — 템플릿을 이미 가진 재사용은 클릭 3 · 이동 1
    expect(n.c).toEqual({ input: 0, click: 4, move: 1 });
  } finally {
    for (const k of kors) await api.deleteTerms(k);
  }
});
