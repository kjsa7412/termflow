/**
 * `pnpm --filter @termflow/server db:new <이름>` — 다음 번호의 빈 SQL 마이그레이션 파일을 만든다.
 * drizzle-kit `generate --custom`은 번호를 0000부터 매겨 설계 규약(0001_baseline, 000n_*)과 어긋나므로
 * 같은 일(빈 SQL + meta/_journal.json 항목 추가)을 번호 규약에 맞춰 한다(PoC T1.2 발견).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MIGRATIONS_FOLDER } from '../src/db/migrate.js';

interface Journal {
  version: string;
  dialect: string;
  entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
}

const name = process.argv[2];
if (!name || !/^[a-z][a-z0-9_]*$/.test(name)) {
  console.error('사용법: db:new <이름>  (소문자·숫자·_; 예: add_term_index)');
  process.exit(2);
}

const journalPath = path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json');
const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal;
const last = journal.entries[journal.entries.length - 1];
const tag = `${String(journal.entries.length + 1).padStart(4, '0')}_${name}`;
const file = path.join(MIGRATIONS_FOLDER, `${tag}.sql`);
if (existsSync(file)) throw new Error(`이미 있음: ${file}`);

writeFileSync(
  file,
  `-- ${tag}: 설명을 적는다. 적용 후에는 수정 금지(해시 대조, T2.1). 문장 사이는 '--> statement-breakpoint'로 나눠도 된다.\n`,
);
journal.entries.push({
  idx: (last?.idx ?? -1) + 1,
  version: last?.version ?? '7',
  when: Math.max(Date.now(), (last?.when ?? 0) + 1),
  tag,
  breakpoints: true,
});
writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
console.log(`[db:new] ${path.relative(process.cwd(), file)} 생성, journal 갱신`);
