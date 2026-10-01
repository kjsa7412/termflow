import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { FullConfig } from '@playwright/test';
import { adminState, seedDemo } from './demo-seed.js';

/** 데모 인스턴스 준비(T12.6): 관리자 로그인(강제 변경 처리) → 데모 데이터 → 관리자 세션 저장. */
export default async function demoSetup(config: FullConfig): Promise<void> {
  const use = config.projects[0]!.use;
  const state = use.storageState as string;
  mkdirSync(path.dirname(state), { recursive: true });
  await seedDemo(use.baseURL!, process.env['DEMO_ADMIN_PASSWORD']);
  await adminState(use.baseURL!, state);
}
