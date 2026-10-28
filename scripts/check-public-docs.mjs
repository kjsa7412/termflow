#!/usr/bin/env node
// pnpm check:public-docs: 저장소 첫 화면 문서(README·CHANGELOG·SECURITY·.github 템플릿)에 사내 이름이 들어가면 실패한다.
// 공개 저장소에서 먼저 보이는 문서라 소개 사이트와 같은 이름 목록(site/tools/leak-names.txt)으로 검사한다.
// CONTRIBUTING·docs/는 개발 기록이라 대상이 아니다.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { leaksIn } from '../site/tools/leaks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES = '.github/ISSUE_TEMPLATE';
const FILES = [
  'README.md',
  'CHANGELOG.md',
  'SECURITY.md',
  '.github/pull_request_template.md',
  ...readdirSync(path.join(ROOT, TEMPLATES)).map((n) => `${TEMPLATES}/${n}`),
];

const hits = FILES.flatMap((f) =>
  leaksIn(readFileSync(path.join(ROOT, f), 'utf8')).map((h) => ({ file: f, ...h })),
);

if (hits.length === 0) {
  console.log(`[check:public-docs] OK — ${FILES.length}개 문서에 사내 이름 0건`);
  process.exit(0);
}
console.error(`[check:public-docs] 실패 — 사내 이름 ${hits.length}건(site/tools/leak-names.txt):`);
for (const h of hits) console.error(`  ${h.file}: ${h.term} … ${h.context}`);
process.exit(1);
