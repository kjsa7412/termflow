import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { Api, PROJECT } from './helpers.js';

/**
 * CR-15 C7~C10 레이아웃 점검: 1366×768 · 1920×1080 · 860×800에서 사용자 관리·테이블 편집기(DDL 패널 열림)·프로젝트 전환
 * 메뉴를 찍고 수치로 확인한다 — 페이지 가로 넘침 없음, 이름·사용자 단추가 꺾이지 않음, 기본컬럼 코멘트 열 폭, 상태 배지가
 * 보이는 영역 안, 메뉴 항목 글자가 상자 밖으로 나가지 않음.
 * `E2E_LAYOUT=1 pnpm -C e2e exec playwright test layout-review --project=chrome` → `e2e/shots/layout/*.png`(gitignore).
 * 데이터는 바꾸지 않는다.
 */
test.skip(!process.env['E2E_LAYOUT'], 'E2E_LAYOUT=1일 때만(레이아웃 점검 자료)');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'e2e', 'shots', 'layout');
const P = `/projects/${PROJECT}`;
const SIZES = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 860, height: 800 },
];

let tableId = 0;
test.beforeAll(async ({ baseURL }, info) => {
  mkdirSync(OUT, { recursive: true });
  const api = await Api.open(baseURL!, info.project.use.storageState as string);
  const page = await api.get<{ items: { tableId: number; tableNm: string }[] }>(
    `/api/v1${P}/tables?q=RP_RSCH_PRJ_MAST&size=5`,
  );
  tableId = (page.items.find((t) => t.tableNm === 'RP_RSCH_PRJ_MAST') ?? page.items[0])!.tableId;
  await api.dispose();
});

/** 페이지 전체 가로 넘침(px). 넘치면 화면 오른쪽 밖으로 나간 요소를 메시지로 남긴다. */
async function pageOverflow(page: Page): Promise<number> {
  const r = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const over = document.documentElement.scrollWidth - vw;
    const out: string[] = [];
    if (over > 1) {
      const clipped = (el: HTMLElement) => {
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement)
          if (getComputedStyle(p).overflowX !== 'visible') return true;
        return false;
      };
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
        const b = el.getBoundingClientRect();
        // absolute 요소는 스크롤 상자 안에 있어도 기준 상자가 밖이면 잘리지 않는다 → 그대로 후보
        const abs = getComputedStyle(el).position === 'absolute';
        if (b.right > vw + 1 && (abs || (b.width > 0 && !clipped(el)))) {
          const pos = getComputedStyle(el).position;
          out.push(
            `${el.tagName.toLowerCase()}.${Array.from(el.classList).join('.')}(${pos}) right=${Math.round(b.right)}`,
          );
          if (out.length > 8) break;
        }
      }
    }
    return { over, out };
  });
  if (r.over > 1) console.log('넘친 요소:', r.out.join(' | '));
  return r.over;
}

/** 글자(텍스트 노드)가 차지한 줄 수 — 줄 높이 절반 안의 위치 차이는 같은 줄(아이콘·배지 세로 정렬 차이 무시). */
const lines = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((root) => {
      const tops: number[] = [];
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        if (!n.textContent?.trim()) continue;
        const r = document.createRange();
        r.selectNodeContents(n);
        for (const rect of Array.from(r.getClientRects())) if (rect.width > 0) tops.push(rect.top);
      }
      tops.sort((a, b) => a - b);
      const lh = Number.parseFloat(getComputedStyle(root).lineHeight) || 18;
      return tops.filter((t, i) => i === 0 || t - tops[i - 1]! > lh / 2).length;
    });

for (const size of SIZES) {
  test.describe(`${size.width}px`, () => {
    test.use({ viewport: size });

    test('사용자 관리: 페이지 가로 넘침 없음, 이름·사용자 단추 한 줄', async ({ page }) => {
      await page.goto('/admin/users');
      await expect(page.locator('table tbody tr').first()).toBeVisible();
      await page.screenshot({ path: path.join(OUT, `users_${size.width}.png`) });
      expect(await pageOverflow(page)).toBeLessThanOrEqual(1);
      expect(await lines(page, '.user-btn')).toBe(1);
      // 이름 칸: 어절 단위로만 꺾인다("시스템 관리자" → 최대 2줄, 음절마다 꺾이면 6줄)
      expect(await lines(page, 'table tbody tr td')).toBeLessThanOrEqual(2);
      // 표 상자 안 행 메뉴(화면 기준 위치): 열면 화면 안에 다 보이고, 메뉴 가운데를 누르면 메뉴가 받는다
      await page
        .locator('table tbody tr')
        .first()
        .getByRole('button', { name: /행 메뉴/ })
        .click();
      const menu = page.locator('.dropdown-menu.is-open');
      await expect(menu).toBeVisible();
      await page.screenshot({ path: path.join(OUT, `users_menu_${size.width}.png`) });
      const ok = await menu.evaluate((m) => {
        const r = m.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return (
          r.top >= 0 &&
          r.left >= 0 &&
          r.bottom <= window.innerHeight &&
          r.right <= window.innerWidth &&
          !!hit &&
          m.contains(hit)
        );
      });
      expect(ok).toBe(true);
    });

    test('테이블 편집기(DDL 패널 열림): 기본컬럼 코멘트 열 폭·상태 배지 보임·라벨 한 줄', async ({
      page,
    }) => {
      await page.addInitScript(() => localStorage.setItem('tf.editor.panel', '1'));
      await page.goto(`${P}/tables/${tableId}`);
      await expect(page.getByTestId('ddl-panel')).toBeVisible();
      await expect(page.getByTestId('default-cols')).toBeVisible();
      await page.screenshot({ path: path.join(OUT, `editor_${size.width}.png`), fullPage: true });
      expect(await pageOverflow(page)).toBeLessThanOrEqual(1);
      // 기본컬럼 코멘트 열(8번째 칸): 전에는 0px로 줄어 한 글자씩 세로로 쌓였다
      const commentW = await page
        .locator('[data-testid="default-cols"] tbody tr')
        .first()
        .locator('td')
        .nth(7)
        .evaluate((el) => el.getBoundingClientRect().width);
      expect(commentW).toBeGreaterThanOrEqual(150);
      // 상태 배지(오른쪽 고정)는 그리드 보이는 영역 안. 편집 영역이 아주 좁으면(is-cramped) 고정을 풀어
      // 왼쪽 고정 열(논리명)과 겹치지 않는다
      const fit = await page.evaluate(() => {
        const wrap = document.querySelector('.grid-wrap')!.getBoundingClientRect();
        const cell = document.querySelector('.grid tbody td.c-status')!.getBoundingClientRect();
        const logical = document.querySelector('.grid tbody td.c-logical')!.getBoundingClientRect();
        const cramped = !!document.querySelector('.editor-main.is-cramped');
        return cramped
          ? cell.left >= logical.right - 1
          : cell.left >= wrap.left - 1 && cell.right <= wrap.right + 1;
      });
      expect(fit).toBe(true);
      expect(await lines(page, 'label[for="ed-phys"]')).toBe(1);
    });

    test('프로젝트 전환 메뉴: 항목 글자가 메뉴 상자 밖으로 나가지 않음', async ({ page }) => {
      await page.goto(`${P}`);
      await page.locator('.project-switcher-btn').click();
      const menu = page.locator('.project-switcher .dropdown-menu.is-open');
      await expect(menu).toBeVisible();
      await page.screenshot({ path: path.join(OUT, `switcher_${size.width}.png`) });
      const spill = await menu.evaluate((m) => {
        const box = m.getBoundingClientRect();
        return Array.from(m.querySelectorAll('.dropdown-item *')).some((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && (r.right > box.right + 1 || r.left < box.left - 1);
        });
      });
      expect(spill).toBe(false);
    });
  });
}

test.describe('1366px 표준 사전 화면(CR-15 C18)', () => {
  test.use({ viewport: { width: 1366, height: 768 } });
  for (const [name, sub] of [
    ['terms', 'standards/terms'],
    ['domain-classes', 'standards/domain-classes'],
    ['default-columns', 'standards/default-columns'],
  ] as const) {
    test(`${name}: 폭 보조 클래스(w-*)가 적용되고 페이지 가로 넘침 없음`, async ({ page }) => {
      await page.goto(`${P}/${sub}`);
      await expect(page.locator('main table tbody tr').first()).toBeVisible();
      await page.screenshot({ path: path.join(OUT, `std_${name}_1366.png`), fullPage: true });
      expect(await pageOverflow(page)).toBeLessThanOrEqual(1);
      // w-80·w-120·w-160 select/input은 그 폭(전에는 100%로 늘어 필터가 한 줄 전체 폭이었다)
      const wrong = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>('main :is(.input, .select)'))
          .map((el) => {
            const m = /\bw-(80|100|120|160|200|240)\b/.exec(el.className);
            return m
              ? { want: Number(m[1]), got: Math.round(el.getBoundingClientRect().width) }
              : null;
          })
          .filter((x) => x && x.got > 0 && Math.abs(x.got - x.want) > 2),
      );
      expect(wrong).toEqual([]);
    });
  }
});

test.describe('1366px 처음 열기', () => {
  test.use({ viewport: { width: 1366, height: 768 } });
  test('저장된 선택이 없으면 DDL 패널은 닫힌 채로 시작(CR-15 C9)', async ({ page }) => {
    await page.addInitScript(() => localStorage.removeItem('tf.editor.panel'));
    await page.goto(`${P}/tables/${tableId}`);
    await expect(page.getByTestId('column-grid')).toBeVisible();
    await expect(page.getByTestId('ddl-panel')).toHaveCount(0);
    await page.screenshot({ path: path.join(OUT, 'editor_1366_first.png') });
  });
});
