import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  Api,
  P,
  PROJECT,
  cell,
  checkLabel,
  counter,
  uniqueKor,
  uniquePhysical,
} from './helpers.js';

/**
 * T10.4 S2(+S4) 브라우저 E2E(설계서 §13.1·§13.2, 검토안 S2·S4): dev 서버 + dev DB(RMS 실데이터).
 *  - S2·G1: 목록 [새 테이블] → 논리 테이블명 + 10컬럼(exact 8·similar 1·composed 1) → PK → 저장 → DDL [복사](클립보드)
 *           → [.sql 다운로드]. 계수 입력 ≤12 · 클릭 ≤6 · 이동 ≤1.
 *  - S4·G2: 미등록 조각 1개 → 인라인 등록 카드 물리약어 → Enter → 자동 재시도(composed) → 승인 큐 PENDING. 입력 ≤2 · 클릭 ≤1 · 이동 0.
 */
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const TABLE = 'RP_PRJ_RCPT_HST';
const EXACT = [
  '전자결재번호',
  '요청일자',
  '심의일자',
  '사용여부',
  '삭제여부',
  '정렬순서',
  '첨부파일ID',
  '비용금액',
];

let api: Api;
let rpId = 0;
let baseTables = 0;

test.beforeAll(async ({ baseURL }, info) => {
  api = await Api.open(baseURL!, info.project.use.storageState as string);
  rpId = await api.bizAreaId('RP');
  await api.deleteTables(TABLE);
  baseTables = await api.tableCount();
});
test.afterAll(async () => {
  await api.deleteTables(TABLE);
  expect(await api.tableCount()).toBe(baseTables);
  await api.dispose();
});

test('S2·G1 — 10컬럼 설계 → 저장 → DDL 복사·다운로드', async ({ page }) => {
  await page.goto(`/projects/${PROJECT}/tables?bizAreaId=${rpId}`);
  const n = counter(page);
  await n.click(page.getByTestId('new-table'));
  await page.waitForURL(/\/tables\/new/);
  n.moved();
  await expect(page.getByTestId('column-grid')).toBeVisible();

  // 논리 테이블명(입력 1) → Tab(change) → 물리명 자동 제안(업무구분 접두어 + 분절)
  await n.type('#ed-logical', '과제접수이력');
  await page.locator('#ed-logical').press('Tab');
  await expect(page.locator('#ed-phys')).toHaveValue(TABLE);

  const names = [...EXACT, '접수일', '과제관리번호'];
  for (let i = 1; i <= names.length; i++) {
    const nm = names[i - 1]!;
    await n.type(`tbody tr[data-row="${i}"] [data-field="logicalNm"]`, nm);
    await cell(page, i, 'logicalNm').press('Enter');
    if (nm === '접수일') {
      // similar: 인라인 listbox — ↓ Enter로 '접수일자'(키보드 = 클릭 0)
      const lb = page.getByTestId('ac-listbox');
      await expect(lb).toBeVisible();
      await cell(page, i, 'logicalNm').press('ArrowDown');
      await expect(lb.locator('[role="option"][aria-selected="true"]')).toContainText('접수일자');
      await cell(page, i, 'logicalNm').press('Enter');
    }
    await expect(cell(page, i + 1, 'logicalNm')).toBeFocused();
  }
  const states = await page
    .locator('tbody tr[data-row]')
    .evaluateAll((trs) => trs.slice(0, 10).map((tr) => tr.getAttribute('data-state')));
  expect(states).toEqual([...Array(9).fill('exact'), 'composed']);
  await expect(cell(page, 9, 'logicalNm')).toHaveValue('접수일자');
  await expect(cell(page, 10, 'physicalNm')).toHaveValue('PRJ_MNGT_NO');

  await n.click(checkLabel(page, 'tbody tr[data-row="1"] [data-field="isPk"]')); // PK
  await expect(cell(page, 1, 'isPk')).toBeChecked();
  const save = page.getByTestId('save');
  await expect(save).toBeEnabled();
  await n.click(save);
  await page.waitForURL(/\/tables\/\d+/);
  await expect(page.getByText(/v1 저장/)).toBeVisible();

  // DDL 패널(기본 열림) → [복사] = 클립보드
  const code = page.getByTestId('ddl-code');
  await expect(code).toContainText(`CREATE TABLE ${TABLE}`);
  const panel = page.getByTestId('ddl-panel');
  const copy = panel.getByRole('button', { name: '복사' });
  await expect(copy).toBeEnabled();
  await n.click(copy);
  await expect(page.getByText('DDL을 클립보드에 복사했습니다')).toBeVisible();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain(`CREATE TABLE ${TABLE}`);
  expect(clip).toContain('RCPT_DT');
  expect(clip).toContain('PRJ_MNGT_NO');

  // G1 계수(편집기 진입 포함): 입력 11 · 클릭 4 · 이동 1
  expect(n.c).toEqual({ input: 11, click: 4, move: 1 });
  test.info().annotations.push({ type: 'G1', description: JSON.stringify(n.c) });

  // [.sql 다운로드](S3 단일의 다운로드 경로, 계수 밖)
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    panel.getByRole('button', { name: '.sql 다운로드' }).click(),
  ]);
  expect(dl.suggestedFilename()).toMatch(/\.sql$/);
  const sql = readFileSync((await dl.path())!, 'utf8');
  expect(sql).toContain(`CREATE TABLE ${TABLE}`);
  // 기본컬럼 9 포함 19컬럼 + PK 제약 1줄
  expect(sql.match(/^\s{4}(?!CONSTRAINT )[A-Z][A-Z0-9_]*\s/gm)?.length).toBe(19);
  expect(sql).toMatch(/CONSTRAINT \S+ PRIMARY KEY \(ELC_APV_NO\)/);
});

test('S4·G2 — 미등록 용어 인라인 등록 → 자동 재시도 → 승인 큐 PENDING', async ({
  page,
  context,
}) => {
  const kor = uniqueKor();
  const phys = uniquePhysical('EE');
  await api.deleteTerms(kor);
  try {
    await page.goto(`/projects/${PROJECT}/tables?bizAreaId=${rpId}`);
    await page.getByTestId('new-table').click();
    await page.waitForURL(/\/tables\/new/);
    await expect(page.getByTestId('column-grid')).toBeVisible();
    // 시나리오 전제 입력(G2 계수 밖): 연구 · (미등록) · 구분
    await cell(page, 1, 'logicalNm').fill(`연구${kor}구분`);
    await cell(page, 1, 'logicalNm').press('Enter');
    const card = page.getByTestId('reg-card');
    await expect(card).toBeVisible();
    await expect(cell(page, 1, 'physicalNm')).toHaveValue('RSCH_?_TP');
    await expect(card.locator('input[readonly]')).toHaveValue(kor);
    const regPhys = page.getByTestId('reg-physical');
    await expect(regPhys).toBeFocused();

    const n = counter(page);
    await n.type('[data-testid="reg-physical"]', phys.toLowerCase());
    await expect(regPhys).toHaveValue(phys);
    await regPhys.press('Enter');
    await expect(cell(page, 1, 'physicalNm')).toHaveValue(`RSCH_${phys}_TP`);
    await expect(card).toBeHidden();
    await expect(page.locator('tbody tr[data-row="1"]')).toHaveAttribute('data-state', 'composed');
    await expect(cell(page, 1, 'typeText')).toHaveValue('VARCHAR(10)');
    await expect(page.locator('tr.sub-row').first()).toContainText('검토대기');
    await expect(cell(page, 2, 'logicalNm')).toBeFocused();
    expect(n.c).toEqual({ input: 1, click: 0, move: 0 });
    test.info().annotations.push({ type: 'G2', description: JSON.stringify(n.c) });

    // 승인 큐에 PENDING 표시(새 탭 — 편집기의 미저장 이탈 확인을 피한다)
    expect(await api.termStatus(kor)).toBe('PENDING');
    const q = await context.newPage();
    await q.goto(`/projects/${PROJECT}/standards/approvals`);
    await expect(q.getByText(kor).first()).toBeVisible();
    await q.close();
  } finally {
    await api.deleteTerms(kor);
    expect(await api.termStatus(kor)).toBeNull();
  }
});

test('S6 — 코드성 컬럼: 연구과제상태코드 → 코드구분 후보 Enter', async ({ page }) => {
  await page.goto(`/projects/${PROJECT}/tables/new?bizAreaId=${rpId}`);
  await expect(page.getByTestId('column-grid')).toBeVisible();
  const n = counter(page);
  await n.type('tbody tr[data-row="1"] [data-field="logicalNm"]', '연구과제상태코드');
  await cell(page, 1, 'logicalNm').press('Enter');
  const lb = page.getByTestId('ac-listbox');
  await expect(lb).toBeVisible();
  await expect(lb).toContainText('코드구분 후보');
  await expect(lb.locator('[role="option"][data-kind="code"]').first()).toContainText('PS/023');
  await cell(page, 1, 'logicalNm').press('Enter');
  await expect(page.locator('tbody tr[data-row="1"]')).toHaveAttribute('data-state', 'code');
  await expect(cell(page, 1, 'physicalNm')).toHaveValue('RSCH_PRJ_STAT_CD');
  await expect(cell(page, 1, 'colComment')).toHaveValue('연구과제상태코드(PS/023 상태)');
  expect(n.c).toEqual({ input: 1, click: 0, move: 0 });
  // 저장 본문의 codeClsId는 test:db autocomplete-rms(S6)가 증명 — 여기서는 저장하지 않는다
  void P;
});
