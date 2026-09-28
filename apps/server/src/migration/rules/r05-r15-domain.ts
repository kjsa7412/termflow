import type { StdType, TypeSource } from '@termflow/shared';
import {
  calculateDomain,
  isNumPart,
  normalizeParts,
  type L1Snapshot,
} from '../../autocomplete/domain-calculator.js';
import { parseStdType, parseTypeAndLength, typeText } from '../../standard/std-type-parser.js';
import type { ReportAction } from '../report-writer.js';
import { isNumericDotZero, normalizeNumericText } from './r01-numeric-terms.js';
import { normalizePhysicalName } from './r09-physical-name.js';

/**
 * DOMAIN step의 행 단위 규칙(설계서 §11.2): R1(명칭 조각 정수 표기) · R9(물리명 정규화) · R15(물리명 재생성) ·
 * R5(타입 미정 도메인) + R5-b(수기 타입 우선, CR-03 C1). L1은 `calculateDomain`을 그대로 호출한다.
 * 순수 함수 — DB를 모르고, 리포트 행을 값으로 돌려준다.
 */
export interface LegacyDomainRow {
  domainId: number;
  nm: readonly (string | null)[];
  logicalNm: string;
  physicalNm: string | null;
  descr: string | null;
  suffix: string | null;
  colType: string | null;
  colLength: string | null;
  colTypeManual: string | null;
}

export interface DomainTarget {
  nm: (string | null)[];
  logicalNm: string;
  physicalNm: string | null;
  descr: string | null;
  suffix: string | null;
  domainClsId: number | null;
  colType: StdType | null;
  colLength: number | null;
  colScale: number | null;
  typeSource: TypeSource;
  reviewYn: boolean;
  reviewNote: string | null;
}

export interface DomainReport {
  file: 'r01_numeric_terms' | 'r05_domain_type' | 'r09_physical_normalized' | 'r15_domain_physical';
  rule: 'R01' | 'R05' | 'R09' | 'R15';
  field: string;
  before: string | null;
  after: string | null;
  action: ReportAction;
  note?: string;
}

export interface DomainDecision {
  target: DomainTarget;
  reports: DomainReport[];
  /** R5 분류(타입 미정 도메인만): MANUAL / RECALC / REVIEW. R5-b(수기 타입 우선)는 MANUAL_OVERRIDE. */
  r5: 'MANUAL' | 'RECALC' | 'REVIEW' | 'MANUAL_OVERRIDE' | null;
  /** R15 분류(물리명 NULL 도메인만). */
  r15: 'RECALC' | 'REVIEW' | null;
  /** L1이 찾지 못한 조각(미등록 조각 리포트용). */
  notFound: readonly string[];
}

const blank = (v: string | null | undefined): boolean => v === null || v === undefined || v.trim() === '';
const typeKey = (t: StdType | null, l: number | null, s: number | null) => typeText(t, l, s) ?? '';

export function decideDomain(row: LegacyDomainRow, snap: L1Snapshot): DomainDecision {
  const reports: DomainReport[] = [];
  const notes: string[] = [];

  // R1: 명칭 조각 '13.0' → '13'
  const nm = row.nm.map((p, i) => {
    if (blank(p)) return null;
    const v = p!.trim();
    if (isNumericDotZero(v)) {
      const after = normalizeNumericText(v);
      reports.push({ file: 'r01_numeric_terms', rule: 'R01', field: `nm${i + 1}`, before: p, after, action: 'NORMALIZED' });
      return after;
    }
    return v;
  });
  while (nm.length < 7) nm.push(null);

  // R9: 논리명 trim, 물리명 upper(trim)
  const logicalNm = row.logicalNm.trim();
  if (logicalNm !== row.logicalNm) {
    reports.push({ file: 'r09_physical_normalized', rule: 'R09', field: 'logical_nm', before: row.logicalNm, after: logicalNm, action: 'NORMALIZED' });
  }
  const pn = normalizePhysicalName(row.physicalNm);
  let physicalNm = pn.value;
  if (pn.changed) {
    reports.push({ file: 'r09_physical_normalized', rule: 'R09', field: 'physical_nm', before: row.physicalNm, after: pn.value, action: 'NORMALIZED' });
  }
  if (pn.formatError || pn.tooLong) {
    const why = pn.formatError ? '물리명 형식 위반' : '물리명 63자 초과';
    reports.push({ file: 'r09_physical_normalized', rule: 'R09', field: 'physical_nm', before: row.physicalNm, after: null, action: 'REVIEW', note: `${why}(자동 수정 없음, NULL로 적재)` });
    notes.push(`${why}: ${pn.value}`);
    physicalNm = null;
  } else if (pn.oracleLong) {
    reports.push({ file: 'r09_physical_normalized', rule: 'R09', field: 'physical_nm', before: row.physicalNm, after: pn.value, action: 'REVIEW', note: 'W Oracle 30자 초과' });
  }

  let suffix = blank(row.suffix) ? null : row.suffix!.trim().toUpperCase();
  let descr = blank(row.descr) ? null : row.descr!;

  // L1(§5.2) — 조각 연결이 논리명과 같을 때만 재계산 결과를 신뢰한다(명칭 조각을 다른 용도로 쓴 원본 행 방지).
  const l1 = calculateDomain({ parts: nm }, snap);
  const consistent = l1.logicalNm.toUpperCase() === logicalNm.toUpperCase();
  const parts = normalizeParts(nm);
  const lastIdx = findLastIndex(parts, (p) => !isNumPart(p));
  const suffixReliable =
    consistent && l1.suffix !== null && lastIdx >= 0 && !l1.notFound.includes(parts[lastIdx]!);

  // R15: 물리명 재생성
  let r15: DomainDecision['r15'] = null;
  if (row.physicalNm === null || row.physicalNm.trim() === '') {
    if (!consistent) {
      r15 = 'REVIEW';
      notes.push('명칭 조각과 논리명 불일치');
      reports.push({ file: 'r15_domain_physical', rule: 'R15', field: 'physical_nm', before: null, after: null, action: 'REVIEW', note: `명칭 조각과 논리명 불일치: ${l1.logicalNm} ≠ ${logicalNm}` });
    } else if (l1.notFound.length > 0) {
      r15 = 'REVIEW';
      const uniq = [...new Set(l1.notFound)];
      notes.push(`미등록 조각: ${uniq.join(', ')}`);
      reports.push({ file: 'r15_domain_physical', rule: 'R15', field: 'physical_nm', before: null, after: null, action: 'REVIEW', note: `미등록 조각: ${uniq.join(', ')}` });
    } else {
      const chk = normalizePhysicalName(l1.physicalNm);
      if (chk.formatError || chk.tooLong) {
        r15 = 'REVIEW';
        notes.push(`재생성 물리명 사용 불가: ${l1.physicalNm}`);
        reports.push({ file: 'r15_domain_physical', rule: 'R15', field: 'physical_nm', before: null, after: l1.physicalNm, action: 'REVIEW', note: '재생성 물리명 형식·길이 위반' });
      } else {
        r15 = 'RECALC';
        physicalNm = chk.value;
        suffix = l1.suffix;
        reports.push({ file: 'r15_domain_physical', rule: 'R15', field: 'physical_nm', before: null, after: physicalNm, action: 'RECALC', note: `suffix=${l1.suffix ?? ''}` });
        if (descr !== l1.descr) {
          reports.push({ file: 'r15_domain_physical', rule: 'R15', field: 'descr', before: descr, after: l1.descr, action: 'RECALC' });
          descr = l1.descr;
        }
      }
    }
  }

  // R5 + R5-b: 타입
  let colType: StdType | null = null;
  let colLength: number | null = null;
  let colScale: number | null = null;
  let typeSource: TypeSource = 'AUTO';
  let r5: DomainDecision['r5'] = null;

  const legacyType = blank(row.colType) ? null : parseTypeAndLength(row.colType, row.colLength);
  const manual = blank(row.colTypeManual) ? null : parseStdType(row.colTypeManual);
  const legacyText = blank(row.colType) ? null : `${row.colType}${blank(row.colLength) ? '' : `(${row.colLength})`}`;

  if (legacyType?.ok) {
    ({ type: colType, length: colLength, scale: colScale } = legacyType);
    if (manual?.ok && typeKey(manual.type, manual.length, manual.scale) !== typeKey(colType, colLength, colScale)) {
      r5 = 'MANUAL_OVERRIDE';
      reports.push({ file: 'r05_domain_type', rule: 'R05', field: 'col_type', before: legacyText, after: manual.normalized, action: 'MANUAL', note: `R5-b 수기 타입 우선(col_type_manual=${row.colTypeManual})` });
      ({ type: colType, length: colLength, scale: colScale } = manual);
      typeSource = 'MANUAL';
    } else if (manual && !manual.ok) {
      notes.push(`수기 타입 해석 불가: ${row.colTypeManual}`);
      reports.push({ file: 'r05_domain_type', rule: 'R05', field: 'col_type_manual', before: row.colTypeManual, after: legacyType.normalized, action: 'REVIEW', note: `수기 타입 해석 불가(${manual.reason}), 접미어 타입 유지` });
    }
  } else {
    if (legacyType && !legacyType.ok) {
      notes.push(`원본 타입 해석 불가: ${legacyText}`);
    }
    if (manual?.ok) {
      r5 = 'MANUAL';
      ({ type: colType, length: colLength, scale: colScale } = manual);
      typeSource = 'MANUAL';
      reports.push({ file: 'r05_domain_type', rule: 'R05', field: 'col_type', before: legacyText, after: manual.normalized, action: 'MANUAL', note: `col_type_manual=${row.colTypeManual}` });
    } else {
      if (manual && !manual.ok) {
        notes.push(`수기 타입 해석 불가: ${row.colTypeManual}`);
        reports.push({ file: 'r05_domain_type', rule: 'R05', field: 'col_type_manual', before: row.colTypeManual, after: null, action: 'REVIEW', note: `수기 타입 해석 불가(${manual.reason}) — 자동 수정 없음` });
      }
      if (suffixReliable && l1.colType !== null) {
        r5 = 'RECALC';
        colType = l1.colType;
        colLength = l1.colLength;
        colScale = l1.colScale;
        suffix = l1.suffix;
        reports.push({ file: 'r05_domain_type', rule: 'R05', field: 'col_type', before: legacyText, after: l1.typeText, action: 'RECALC', note: `suffix=${l1.suffix}` });
      } else {
        r5 = 'REVIEW';
        const why = !consistent
          ? '명칭 조각과 논리명 불일치'
          : (() => {
              const sfx = suffixReliable ? l1.suffix : suffix;
              return sfx === null ? '접미어 없음' : `접미어 ${sfx} 미등록`;
            })();
        if (!notes.includes(why)) notes.push(why);
        reports.push({ file: 'r05_domain_type', rule: 'R05', field: 'col_type', before: legacyText, after: null, action: 'REVIEW', note: why });
      }
    }
  }

  const cls = suffix !== null ? snap.clsBySuffix.get(suffix) : undefined;
  const reviewNote = notes.length > 0 ? notes.join('; ').slice(0, 500) : null;
  return {
    target: {
      nm,
      logicalNm,
      physicalNm,
      descr,
      suffix,
      domainClsId: cls?.domainClsId ?? null,
      colType,
      colLength,
      colScale,
      typeSource,
      reviewYn: notes.length > 0,
      reviewNote,
    },
    reports,
    r5,
    r15,
    notFound: consistent ? l1.notFound : [],
  };
}

function findLastIndex<T>(arr: readonly T[], pred: (v: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i]!)) return i;
  return -1;
}
