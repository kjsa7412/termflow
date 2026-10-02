import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 리포트 CSV 작성기(설계서 §11.3, T3.6). 경로 `migration/report/{run_id}/{rNN_name}.csv`,
 * UTF-8 BOM(엑셀에서 한글이 깨지지 않도록), 헤더 고정.
 */
export const REPORT_HEADER = [
  'rule',
  'step',
  'legacy_key',
  'target_table',
  'target_id',
  'field',
  'before',
  'after',
  'action',
  'note',
] as const;

export const SUMMARY_HEADER = [
  'step',
  'rule',
  'source_cnt',
  'loaded_cnt',
  'excluded_cnt',
  'flagged_cnt',
  'status',
  'seconds',
] as const;

export const RECONCILE_HEADER = [
  'item',
  'legacy_cnt',
  'excluded_cnt',
  'template_cnt',
  'rms_cnt',
  'flagged_cnt',
  'check',
  'result',
  'note',
] as const;

export const REPORT_ACTIONS = [
  'NORMALIZED',
  'NULLED',
  'RECALC',
  'MANUAL',
  'REVIEW',
  'SKIPPED',
  'ERROR',
] as const;
export type ReportAction = (typeof REPORT_ACTIONS)[number];

export interface ReportRow {
  rule: string;
  step: string;
  legacyKey: string | number | null;
  targetTable: string | null;
  targetId: string | number | null;
  field: string | null;
  before: string | number | null;
  after: string | number | null;
  action: ReportAction;
  note?: string | null;
}

const BOM = String.fromCharCode(0xfeff);

/** RFC 4180: 쉼표·따옴표·개행이 있으면 큰따옴표로 감싸고 내부 따옴표는 두 번. 수식 주입(=,+,-,@) 방지 접두 `'`. */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function csvLine(cells: readonly unknown[]): string {
  return cells.map(csvCell).join(',');
}

/** BOM + 헤더 + 행(CRLF — 엑셀 기본). */
export function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return BOM + [csvLine(header), ...rows.map(csvLine)].join('\r\n') + '\r\n';
}

function rowCells(r: ReportRow): unknown[] {
  return [
    r.rule,
    r.step,
    r.legacyKey,
    r.targetTable,
    r.targetId,
    r.field,
    r.before,
    r.after,
    r.action,
    r.note ?? null,
  ];
}

/**
 * 실행 1회(run_id)의 리포트 모음. step이 규칙별 파일(`r05_domain_type` 등)에 행을 쌓고,
 * `flush()`가 파일로 쓴다(행이 0건이어도 헤더만 있는 파일을 남겨 "0건"을 증명한다).
 */
export class ReportWriter {
  private readonly files = new Map<string, ReportRow[]>();
  readonly dir: string;

  constructor(reportRoot: string, runId: string) {
    this.dir = path.join(reportRoot, runId);
  }

  /** 파일을 미리 등록(0건이어도 생성). */
  declare(file: string): void {
    if (!this.files.has(file)) this.files.set(file, []);
  }

  add(file: string, row: ReportRow): void {
    this.declare(file);
    this.files.get(file)!.push(row);
  }

  count(file: string): number {
    return this.files.get(file)?.length ?? 0;
  }

  rows(file: string): readonly ReportRow[] {
    return this.files.get(file) ?? [];
  }

  fileNames(): string[] {
    return [...this.files.keys()];
  }

  pathOf(file: string): string {
    return path.join(this.dir, `${file}.csv`);
  }

  /** 등록된 규칙 파일을 쓰고 경로 목록을 돌려준다. */
  flush(): string[] {
    mkdirSync(this.dir, { recursive: true });
    const written: string[] = [];
    for (const [file, rows] of this.files) {
      const p = this.pathOf(file);
      writeFileSync(p, toCsv(REPORT_HEADER, rows.map(rowCells)), 'utf8');
      written.push(p);
    }
    return written;
  }

  writeTable(
    file: string,
    header: readonly string[],
    rows: readonly (readonly unknown[])[],
  ): string {
    mkdirSync(this.dir, { recursive: true });
    const p = this.pathOf(file);
    writeFileSync(p, toCsv(header, rows), 'utf8');
    return p;
  }
}
