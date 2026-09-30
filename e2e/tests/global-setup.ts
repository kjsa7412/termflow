import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, type FullConfig } from '@playwright/test';

/** 로그인 화면으로 한 번 로그인해 세션 쿠키를 저장한다(모든 테스트가 재사용). */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const use = config.projects[0]!.use;
  const state = use.storageState as string;
  mkdirSync(path.dirname(state), { recursive: true });
  const login = process.env['E2E_LOGIN'] ?? '';
  const password = process.env['E2E_PASSWORD'] ?? '';
  if (!password)
    throw new Error('.env에 TERMFLOW_ADMIN_DEV_CURRENT_PASSWORD(또는 E2E_PASSWORD)가 필요합니다');
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage({ baseURL: use.baseURL });
    await page.goto('/login');
    await page.locator('#login-id').fill(login);
    await page.locator('#login-pw').fill(password);
    await page.getByRole('button', { name: /로그인/ }).click();
    await page.waitForURL(/\/projects(\/|$|\?)/, { timeout: 30_000 });
    await page.context().storageState({ path: state });
  } finally {
    await browser.close();
  }
}
