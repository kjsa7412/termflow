import { readFileSync } from 'node:fs';
import type { Dialect } from '@termflow/shared';
import { ddlResource } from './resources.js';

/**
 * 예약어 목록(설계서 §6.9). `resources/ddl/reserved/{postgresql,oracle,mysql}.txt` — 한 줄 한 단어, `#` 주석에 출처·버전.
 * 판정은 식별자 **전체**를 대소문자 무시 비교한다(`_DESC`로 끝나는 부분 일치는 무관). 실행 중 변경 없음(재기동).
 */
export const RESERVED_FILES: Record<Dialect, string> = {
  POSTGRESQL: 'postgresql.txt',
  ORACLE: 'oracle.txt',
  MYSQL: 'mysql.txt',
};

/** PostgreSQL: catcode R(예약)·T(예약, 함수·타입명으로만 허용) — 둘 다 비인용 컬럼·테이블명으로 쓸 수 없다. */
export const RESERVED_KEYWORDS_SQL =
  "select upper(word) as word from pg_get_keywords() where catcode in ('R', 'T') order by 1";

export function parseReservedFile(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    out.add(line.toUpperCase());
  }
  return out;
}

/** `ddl:reserved` 스크립트 출력(생성 일시는 넣지 않는다 — 같은 서버 버전이면 재생성해도 파일이 같다). */
export function renderReservedFile(serverVersion: string, words: readonly string[]): string {
  const sorted = [...new Set(words.map((w) => w.toUpperCase()))].sort();
  return [
    '# PostgreSQL 예약어(설계서 §6.9) — 비인용 식별자로 쓸 수 없는 단어. 판정: 식별자 전체, 대소문자 무시',
    "# 출처: pg_get_keywords() catcode 'R'(reserved)·'T'(reserved, can be function or type name)",
    `# 버전: PostgreSQL ${serverVersion} · 생성: pnpm --filter @termflow/server ddl:reserved`,
    `# 단어 수: ${sorted.length}`,
    ...sorted,
    '',
  ].join('\n');
}

const cache = new Map<Dialect, ReadonlySet<string>>();

export function reservedWords(dialect: Dialect): ReadonlySet<string> {
  let set = cache.get(dialect);
  if (!set) {
    set = parseReservedFile(readFileSync(ddlResource('reserved', RESERVED_FILES[dialect]), 'utf8'));
    cache.set(dialect, set);
  }
  return set;
}

export function isReserved(dialect: Dialect, name: string): boolean {
  return reservedWords(dialect).has(name.toUpperCase());
}

/** 파일 머리 주석(출처·버전 확인용). */
export function reservedFileHeader(dialect: Dialect): string[] {
  return readFileSync(ddlResource('reserved', RESERVED_FILES[dialect]), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.startsWith('#'));
}
