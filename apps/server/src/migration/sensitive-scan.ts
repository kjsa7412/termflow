/**
 * dump 민감값 사전 점검(T3.1, 설계서 §14.4 Q2·RK11). 원본 dump를 읽기만 한다(적재 전 실행 가능).
 *
 *   pnpm --filter @termflow/server migrate:scan [-- --dump=<path>]
 *
 * 점검 대상: 모든 INSERT 값(코드명·코멘트·설명 등 문자열 열)에서 개인정보 패턴을 찾고,
 * 사용자·IP 열(firs/fina_reg_user_id·_ip)은 distinct 값을 목록으로 남긴다.
 * 결과: `migration/report/sensitive-scan.csv`(UTF-8 BOM) + 콘솔 요약. 값은 앞뒤 일부만 남기고 가린다.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReportWriter } from './report-writer.js';

export interface SensitivePattern {
  id: string;
  label: string;
  re: RegExp;
}

export const SENSITIVE_PATTERNS: readonly SensitivePattern[] = [
  {
    id: 'RRN',
    label: '주민등록번호',
    re: /(?<!\d)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])-?[1-4]\d{6}(?!\d)/,
  },
  { id: 'MOBILE', label: '휴대전화번호', re: /(?<!\d)01[016789]-?\d{3,4}-?\d{4}(?!\d)/ },
  { id: 'PHONE', label: '유선전화번호', re: /(?<!\d)0(?!1[016789])\d{1,2}-\d{3,4}-\d{4}(?!\d)/ },
  { id: 'EMAIL', label: '이메일', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { id: 'CARD', label: '카드번호', re: /(?<!\d)\d{4}-\d{4}-\d{4}-\d{4}(?!\d)/ },
  {
    id: 'IP',
    label: 'IP 주소(루프백 제외)',
    re: /(?<![\d.])(?!127\.0\.0\.1(?![\d.]))(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/,
  },
];

/** 사용자·접속 정보 열: 값 자체를 목록으로 확인한다. */
const USER_COLUMNS = /(_user_id|_ip)$/;

export interface Finding {
  table: string;
  column: string;
  rowNo: number;
  kind: string;
  value: string;
}

export interface ScanResult {
  tables: Record<string, number>;
  findings: Finding[];
  userValues: Map<string, Map<string, number>>;
}

/** 가림: 앞 2자·뒤 2자만 남김(4자 이하는 전부 가림). */
export function mask(v: string): string {
  if (v.length <= 4) return '*'.repeat(v.length);
  return `${v.slice(0, 2)}${'*'.repeat(Math.min(v.length - 4, 12))}${v.slice(-2)}`;
}

/** `INSERT INTO s.t VALUES (…);`의 값 목록 파싱(문자열 '' 이스케이프, NULL, 숫자). */
export function parseValues(tuple: string): (string | null)[] {
  const out: (string | null)[] = [];
  let i = 0;
  const n = tuple.length;
  while (i < n) {
    while (i < n && (tuple[i] === ' ' || tuple[i] === ',')) i++;
    if (i >= n) break;
    if (tuple[i] === "'") {
      let s = '';
      i++;
      while (i < n) {
        if (tuple[i] === "'") {
          if (tuple[i + 1] === "'") {
            s += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += tuple[i];
        i++;
      }
      out.push(s);
    } else {
      let j = i;
      while (j < n && tuple[j] !== ',') j++;
      const tok = tuple.slice(i, j).trim();
      out.push(tok.toUpperCase() === 'NULL' ? null : tok);
      i = j;
    }
  }
  return out;
}

export function scanDump(dump: string): ScanResult {
  const lines = dump.replace(/\r\n/g, '\n').split('\n');
  const columns = new Map<string, string[]>();
  let current: string | null = null;
  for (const l of lines) {
    const m = /^CREATE TABLE \w+\.(\w+) \($/.exec(l);
    if (m) {
      current = m[1]!;
      columns.set(current, []);
      continue;
    }
    if (current) {
      if (l.startsWith(')')) {
        current = null;
        continue;
      }
      const c = /^\s+(\w+)\s/.exec(l);
      if (c) columns.get(current)!.push(c[1]!);
    }
  }
  const tables: Record<string, number> = {};
  const findings: Finding[] = [];
  const userValues = new Map<string, Map<string, number>>();
  for (const l of lines) {
    const m = /^INSERT INTO \w+\.(\w+) VALUES \((.*)\);$/.exec(l);
    if (!m) continue;
    const table = m[1]!;
    tables[table] = (tables[table] ?? 0) + 1;
    const cols = columns.get(table) ?? [];
    const vals = parseValues(m[2]!);
    vals.forEach((v, idx) => {
      if (v === null || v === '') return;
      const column = cols[idx] ?? `#${idx + 1}`;
      if (USER_COLUMNS.test(column)) {
        const key = `${table}.${column}`;
        const map = userValues.get(key) ?? new Map<string, number>();
        map.set(v, (map.get(v) ?? 0) + 1);
        userValues.set(key, map);
        if (!column.endsWith('_ip')) return;
      }
      for (const p of SENSITIVE_PATTERNS) {
        const hit = p.re.exec(v);
        if (hit) findings.push({ table, column, rowNo: tables[table]!, kind: p.id, value: hit[0] });
      }
    });
  }
  return { tables, findings, userValues };
}

function main(): number {
  const argDump = process.argv.find((a) => a.startsWith('--dump='))?.slice(7);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const dumpPath = argDump ?? path.join(root, 'seed', 'original', 'dump-gen_table-new.sql');
  if (!existsSync(dumpPath)) {
    console.error(`[migrate:scan] dump 없음: ${dumpPath}`);
    return 1;
  }
  const r = scanDump(readFileSync(dumpPath, 'utf8'));
  const rows: unknown[][] = [];
  for (const f of r.findings) {
    const label = SENSITIVE_PATTERNS.find((p) => p.id === f.kind)!.label;
    rows.push(['PATTERN', f.kind, label, `${f.table}.${f.column}`, f.rowNo, mask(f.value)]);
  }
  for (const [col, map] of r.userValues) {
    for (const [v, cnt] of map)
      rows.push(['USER_COLUMN', 'DISTINCT', '사용자·접속 열 값', col, cnt, v]);
  }
  const writer = new ReportWriter(path.join(root, 'migration', 'report'), '.');
  const out = writer.writeTable(
    'sensitive-scan',
    ['category', 'kind', 'label', 'table_column', 'row_or_count', 'value_masked'],
    rows,
  );
  console.log(`[migrate:scan] INSERT 행: ${JSON.stringify(r.tables)}`);
  const byKind = new Map<string, number>();
  for (const f of r.findings) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
  console.log(
    `[migrate:scan] 개인정보 패턴: ${byKind.size === 0 ? '0건' : [...byKind].map(([k, n]) => `${k} ${n}건`).join(', ')}`,
  );
  for (const [col, map] of r.userValues) {
    console.log(`[migrate:scan] ${col}: ${[...map].map(([v, n]) => `${v}(${n})`).join(', ')}`);
  }
  console.log(`[migrate:scan] 결과 ${out}`);
  return 0;
}

const isEntry =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) process.exit(main());
