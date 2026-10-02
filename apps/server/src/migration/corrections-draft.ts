/**
 * 정정 준비 초안(T6.14, 설계서 §11.5 정정 창·RK1). 대상 프로젝트(기본 RETAILV1)의 검토필요 도메인에서 정정 xlsx 초안을 만든다.
 *
 *   pnpm --filter @termflow/server corrections:draft [-- --project=RETAILV1 --out=migration/corrections]
 *
 *  - terms.xlsx          미등록 조각(한글용어) — 물리약어 칸을 정정 담당자가 채운다(비어 있으면 적용 시 오류 행으로 제외)
 *  - domain-classes.xlsx 미등록 접미어 — 명칭·타입·길이를 채운다
 *  - domains.xlsx        검토필요 도메인의 명칭 조각(그대로 다시 올리면 새 용어·분류로 계산), 둘째 시트에 검토 사유
 * 순서: 용어 → 도메인분류 → 도메인 일괄 등록 → 도메인 [재계산 REVIEW_ONLY](운영 본실행 T11.8에서도 같은 파일을 재적용).
 * DB는 읽기만 한다.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { loadEnvOrExit } from '../config/load-env.js';
import { createPool } from '../db/client.js';
import { domainClassesEngine } from '../standard/import/domain-classes.engine.js';
import { domainsEngine } from '../standard/import/domains.engine.js';
import { termsEngine } from '../standard/import/terms.engine.js';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function write(
  file: string,
  sheet: string,
  header: string[],
  rows: (string | number | null)[][],
  extra?: { name: string; header: string[]; rows: (string | number | null)[][] },
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.addRow(header).font = { bold: true };
  for (const r of rows) ws.addRow(r);
  ws.columns.forEach((c) => (c.width = 16));
  if (extra) {
    const x = wb.addWorksheet(extra.name);
    x.addRow(extra.header).font = { bold: true };
    for (const r of extra.rows) x.addRow(r);
    x.columns.forEach((c) => (c.width = 30));
  }
  await wb.xlsx.writeFile(file);
}

async function main(): Promise<void> {
  const env = loadEnvOrExit();
  const projectKey = arg('project', 'RETAILV1');
  const out = path.resolve(arg('out', path.join(process.cwd(), '../../migration/corrections')));
  mkdirSync(out, { recursive: true });
  const pool = createPool({ ...env, DB_POOL_MAX: 2 });
  try {
    const { rows: p } = await pool.query<{ project_id: number }>(
      'select project_id from tf_project where project_key = $1',
      [projectKey],
    );
    if (!p[0]) throw new Error(`프로젝트 ${projectKey}가 없습니다`);
    const pid = p[0].project_id;
    const { rows: doms } = await pool.query<{
      logical_nm: string;
      nm: (string | null)[];
      review_note: string | null;
    }>(
      `select logical_nm, array[nm1, nm2, nm3, nm4, nm5, nm6, nm7] nm, review_note
         from std_domain where project_id = $1 and review_yn order by logical_nm collate "C"`,
      [pid],
    );
    const parts = new Map<string, { n: number; sample: string[] }>();
    const suffixes = new Map<string, { n: number; sample: string[] }>();
    const bump = (m: typeof parts, k: string, logical: string) => {
      const v = m.get(k) ?? { n: 0, sample: [] };
      v.n++;
      if (v.sample.length < 3) v.sample.push(logical);
      m.set(k, v);
    };
    for (const d of doms) {
      const note = d.review_note ?? '';
      const miss = /미등록 조각: ([^;/]+)/.exec(note)?.[1];
      for (const part of miss?.split(',').map((s) => s.trim()).filter(Boolean) ?? [])
        bump(parts, part, d.logical_nm);
      const sfx = /접미어 ([A-Z0-9_]+) 미등록/.exec(note)?.[1];
      if (sfx) bump(suffixes, sfx, d.logical_nm);
    }
    const byCount = <T>(m: Map<string, { n: number; sample: string[] }>, f: (k: string, v: { n: number; sample: string[] }) => T) =>
      [...m].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0])).map(([k, v]) => f(k, v));
    await write(
      path.join(out, 'terms.xlsx'),
      '용어',
      termsEngine.columns.map((c) => c.label),
      byCount(parts, (k, v) => [k, null, `정정 대상(도메인 ${v.n}건: ${v.sample.join(', ')})`, null]),
    );
    await write(
      path.join(out, 'domain-classes.xlsx'),
      '도메인분류',
      domainClassesEngine.columns.map((c) => c.label),
      byCount(suffixes, (k, v) => [k, null, null, null, null, `정정 대상(도메인 ${v.n}건: ${v.sample.join(', ')})`]),
    );
    await write(
      path.join(out, 'domains.xlsx'),
      '도메인',
      domainsEngine.columns.map((c) => c.label),
      doms.map((d) => [...d.nm.slice(0, 7), null, null, null]),
      {
        name: '검토사유',
        header: ['논리명', '검토 사유'],
        rows: doms.map((d) => [d.logical_nm, d.review_note]),
      },
    );
    console.log(
      `[corrections:draft] ${projectKey}: 검토필요 도메인 ${doms.length} · 미등록 조각 ${parts.size}종 · 미등록 접미어 ${suffixes.size}종 → ${out}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
