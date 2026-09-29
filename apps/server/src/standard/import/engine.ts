import type { ImportIssue, ImportKind, ImportRow, StdEntityType } from '@termflow/shared';
import type { Audit } from '../../common/audit/audit.js';
import type { Tx } from '../std-write.js';
import type { Db } from '../../db/client.js';
import type { RawRow, SheetColumn } from './xlsx.js';

/**
 * 일괄 등록 종류별 엔진(§9.4 표). 미리보기와 적용이 같은 `plan`을 쓴다 — 적용은 트랜잭션 안에서 현재 상태를 다시 읽어
 * 다시 판정하므로(미리보기 이후 다른 사용자의 변경 반영), 적용 결과 건수가 미리보기와 다를 수 있다(응답에 실제 건수).
 */
/** 상태 적재 실행자(Db 또는 트랜잭션). */
export type LoadQ = Pick<Db, 'execute' | 'select'>;

export interface Planned<O> {
  row: ImportRow;
  /** NEW·UPDATE 행의 적용 내용(SKIP·ERROR는 null). */
  op: O | null;
}

export interface ApplyCount {
  new: number;
  update: number;
}

export interface KindEngine<S = unknown, O = unknown> {
  kind: ImportKind;
  entityType: StdEntityType;
  /** 화면·파일명 표시(예: 용어). */
  title: string;
  columns: readonly SheetColumn[];
  /** 미리보기 표의 계산 열(도메인 L1 결과). */
  computed?: readonly { key: string; label: string }[];
  example: readonly (string | number | null)[];
  notes?: readonly string[];
  load(q: LoadQ, projectId: number): Promise<S>;
  plan(rows: readonly RawRow[], state: S): Planned<O>[];
  apply(
    tx: Tx,
    projectId: number,
    rows: readonly Planned<O>[],
    state: S,
    a: Audit,
    batchId: string,
  ): Promise<ApplyCount>;
}

export const issue = (code: string, message: string, field?: string): ImportIssue =>
  field !== undefined ? { code, message, field } : { code, message };

/** 필수 텍스트 셀(길이 상한). */
export function reqText(
  cells: Record<string, string | null>,
  key: string,
  label: string,
  max: number,
  errors: ImportIssue[],
): string {
  const v = cells[key] ?? null;
  if (v === null) {
    errors.push(issue('E_REQUIRED', `${label}이(가) 비어 있습니다`, key));
    return '';
  }
  if (v.length > max) errors.push(issue('E_LENGTH', `${label}은(는) ${max}자 이내입니다`, key));
  return v;
}

/** 선택 텍스트 셀(빈 값 = null). */
export function optText(
  cells: Record<string, string | null>,
  key: string,
  label: string,
  max: number,
  errors: ImportIssue[],
): string | null {
  const v = cells[key] ?? null;
  if (v !== null && v.length > max)
    errors.push(issue('E_LENGTH', `${label}은(는) ${max}자 이내입니다`, key));
  return v;
}

/** 정수 셀(빈 값 = null, `13.0` 같은 정수 표기 허용). */
export function intCell(
  cells: Record<string, string | null>,
  key: string,
  label: string,
  min: number,
  max: number,
  errors: ImportIssue[],
): number | null {
  const v = cells[key] ?? null;
  if (v === null) return null;
  const m = /^-?\d+(\.0+)?$/.exec(v.replace(/,/g, ''));
  const n = m ? Number.parseInt(v.replace(/,/g, ''), 10) : Number.NaN;
  if (!Number.isInteger(n) || n < min || n > max) {
    errors.push(issue('E_NUMBER', `${label}은(는) ${min}~${max} 정수여야 합니다: ${v}`, key));
    return null;
  }
  return n;
}

/** Y/N 셀(빈 값 = null). */
export function ynCell(
  cells: Record<string, string | null>,
  key: string,
  label: string,
  errors: ImportIssue[],
): boolean | null {
  const v = (cells[key] ?? '').toUpperCase();
  if (v === '') return null;
  if (['Y', 'YES', 'TRUE', '1', '사용'].includes(v)) return true;
  if (['N', 'NO', 'FALSE', '0', '미사용', '사용안함'].includes(v)) return false;
  errors.push(issue('E_FORMAT', `${label}은(는) Y 또는 N입니다: ${cells[key]}`, key));
  return null;
}

/** 파일 안 같은 키: 뒤 행을 ERROR(§9.4 "파일 내 중복 키(뒤 행 ERROR)"). */
export class FileKeys {
  private readonly seen = new Map<string, number>();

  /** 처음 보는 키면 true(기록), 앞 행에 있으면 오류를 넣고 false. */
  claim(key: string, rowNo: number, errors: ImportIssue[], label: string): boolean {
    const prev = this.seen.get(key);
    if (prev !== undefined) {
      errors.push(issue('E_IMPORT_FILE_DUP', `${label} '${key}'이(가) ${prev}행과 중복됩니다`));
      return false;
    }
    this.seen.set(key, rowNo);
    return true;
  }
}

/** 행 판정 마무리: 오류 → ERROR, 신규 → NEW, 바뀐 필드 있음 → UPDATE, 없음 → SKIP(동일). */
export function finish<O>(base: Omit<ImportRow, 'status'>, isNew: boolean, op: O): Planned<O> {
  if (base.errors.length > 0) return { row: { ...base, status: 'ERROR' }, op: null };
  if (isNew) return { row: { ...base, status: 'NEW' }, op };
  if (Object.keys(base.changes).length > 0) return { row: { ...base, status: 'UPDATE' }, op };
  return { row: { ...base, status: 'SKIP' }, op: null };
}

/** 기존 값과 새 값이 다르면 changes에 [기존, 새]. 새 값이 undefined면 "변경 없음". */
export function diff(
  changes: Record<string, [unknown, unknown]>,
  field: string,
  before: unknown,
  after: unknown,
): void {
  if (after === undefined) return;
  if ((before ?? null) !== (after ?? null)) changes[field] = [before ?? null, after ?? null];
}
