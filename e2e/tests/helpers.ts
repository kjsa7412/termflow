import { request, type APIRequestContext, type Page } from '@playwright/test';

export const PROJECT = 'RMS';
export const P = `/api/v1/projects/${PROJECT}`;

/** 저장된 세션으로 API 호출(정리용). 비-GET에는 CSRF 헤더를 붙인다(SPA api/client.ts와 같은 규칙). */
export class Api {
  private constructor(
    readonly ctx: APIRequestContext,
    private readonly csrf: string,
  ) {}

  static async open(baseURL: string, storageState: string): Promise<Api> {
    const ctx = await request.newContext({ baseURL, storageState });
    const r = await ctx.get('/api/v1/auth/csrf');
    const { token } = (await r.json()) as { token: string };
    return new Api(ctx, token);
  }

  async get<T>(path: string): Promise<T> {
    const r = await this.ctx.get(path);
    if (!r.ok()) throw new Error(`GET ${path} → ${r.status()}`);
    return (await r.json()) as T;
  }

  async send(method: 'post' | 'put' | 'delete', path: string, data?: unknown): Promise<number> {
    const r = await this.ctx[method](path, {
      headers: { 'X-XSRF-TOKEN': this.csrf },
      ...(data !== undefined ? { data } : {}),
    });
    return r.status();
  }

  async bizAreaId(bizCd: string): Promise<number> {
    const list = await this.get<{ bizAreaId: number; bizCd: string }[]>(`${P}/biz-areas`);
    const b = list.find((x) => x.bizCd === bizCd);
    if (!b) throw new Error(`업무구분 ${bizCd} 없음`);
    return b.bizAreaId;
  }

  async tableCount(): Promise<number> {
    return (await this.get<{ total: number }>(`${P}/tables?size=1`)).total;
  }

  /** 이름이 정확히 같은 테이블 삭제(DRAFT). */
  async deleteTables(tableNm: string): Promise<void> {
    const page = await this.get<{ items: { tableId: number; tableNm: string }[] }>(
      `${P}/tables?q=${encodeURIComponent(tableNm)}&size=50`,
    );
    for (const t of page.items.filter((x) => x.tableNm === tableNm)) {
      await this.send('delete', `${P}/tables/${t.tableId}`);
    }
  }

  /** 한글 용어가 정확히 같은 용어 삭제. 검토대기(PENDING)는 반려 후 삭제(검토대기 삭제는 409, CR-05 C2). */
  async deleteTerms(termKor: string): Promise<void> {
    const page = await this.get<{ items: { termId: number; termKor: string; status: string }[] }>(
      `${P}/standards/terms?q=${encodeURIComponent(termKor)}&size=50`,
    );
    for (const t of page.items.filter((x) => x.termKor === termKor)) {
      if (t.status === 'PENDING')
        await this.send('post', `${P}/standards/approvals/${t.termId}/reject`, {
          note: 'E2E 정리',
        });
      await this.send('delete', `${P}/standards/terms/${t.termId}`);
    }
  }

  async termStatus(termKor: string): Promise<string | null> {
    const page = await this.get<{ items: { termKor: string; status: string }[] }>(
      `${P}/standards/terms?q=${encodeURIComponent(termKor)}&size=50`,
    );
    return page.items.find((x) => x.termKor === termKor)?.status ?? null;
  }

  async dispose(): Promise<void> {
    await this.ctx.dispose();
  }
}

/** 사전에 없을 법한 한글 음절로 고유 용어를 만든다(테스트마다 다름). */
const RARE = ['뷁', '쀍', '햏', '똠', '꽑', '뙇', '휑', '펲', '뙁', '쉩'];
export function uniqueKor(n = 3): string {
  const t = Date.now();
  let s = '';
  for (let i = 0; i < n; i++) s += RARE[Math.floor(t / 10 ** i) % RARE.length];
  return s;
}
export function uniquePhysical(prefix: string): string {
  return `${prefix}${String(Date.now()).slice(-5)}`;
}

/** 검토안 4.3 계수기: 입력 = 값을 타이핑한 필드 수, 클릭 = 마우스 클릭(키보드 Enter·↑↓는 0), 이동 = 페이지 전환. */
export function counter(page: Page) {
  const c = { input: 0, click: 0, move: 0 };
  return {
    c,
    async type(selector: string, value: string) {
      c.input++;
      await page.locator(selector).fill(value);
    },
    async click(loc: ReturnType<Page['locator']>) {
      c.click++;
      await loc.click();
    },
    moved() {
      c.move++;
    },
  };
}

export const cell = (page: Page, row: number, field: string) =>
  page.locator(`tbody tr[data-row="${row}"] [data-field="${field}"]`);

/** 사용자 지정 체크박스(`label.check` > 숨긴 input + 그린 상자): 사용자가 누르는 곳 = 라벨. */
export const checkLabel = (page: Page, inputSelector: string) =>
  page.locator(inputSelector).locator('xpath=ancestor::label[1]');
