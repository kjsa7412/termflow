import { STD_TYPES, type StdType } from '@termflow/shared';
import { parseStdType, parseTypeAndLength } from '../../standard/std-type-parser.js';

/**
 * R3 도메인분류 길이 정수화(§11.2): `col_length ~ '^\d+(\.0)?$'` → 정수, `'^\d+,\d+$'` → precision/scale 분리,
 * `col_type ~* '^TIMESTAMP\((\d)\)'` → TIMESTAMP + length n. 그 외 값은 길이 NULL + review_yn.
 * 파싱은 R16 파서가 한다(규칙 단일 구현).
 */
export interface DomainClsTypeResult {
  colType: StdType;
  colLength: number | null;
  colScale: number | null;
  review: boolean;
  reviewNote: string | null;
  /** 리포트 행 1건(길이 문자열 → 3분할은 field=col_length, `TIMESTAMP(n)` 분리는 field=col_type). 변환 없으면 null. */
  change: { field: 'col_type' | 'col_length'; before: string; after: string } | null;
}

export function convertDomainClsType(colType: string, colLength: string | null): DomainClsTypeResult {
  const parsed = parseTypeAndLength(colType, colLength);
  if (!parsed.ok) {
    // 타입명만이라도 표준이면 살리고 길이는 NULL + review. 타입명도 모르면 CHECK 위반이므로 실패.
    const bare = parseStdType(colType.trim().replace(/\(.*$/, ''));
    const name = colType.trim().toUpperCase().replace(/\(.*$/, '');
    const type = bare.ok ? bare.type : (STD_TYPES as readonly string[]).includes(name) ? name : null;
    if (!type) throw new Error(`R3 도메인분류 타입 해석 불가: ${colType} / ${colLength ?? ''}`);
    return {
      colType: type as StdType,
      colLength: null,
      colScale: null,
      review: true,
      reviewNote: `길이 해석 불가: ${colLength ?? ''} (${parsed.reason})`,
      change: { field: 'col_length', before: `${colType}|${colLength ?? ''}`, after: '' },
    };
  }
  let change: DomainClsTypeResult['change'] = null;
  const after = parsed.normalized;
  if (colType.includes('(')) {
    change = { field: 'col_type', before: colType, after };
  } else if (colLength !== null && colLength.trim() !== '') {
    change = { field: 'col_length', before: `${colType}|${colLength}`, after };
  }
  return {
    colType: parsed.type,
    colLength: parsed.length,
    colScale: parsed.scale,
    review: false,
    reviewNote: null,
    change,
  };
}
