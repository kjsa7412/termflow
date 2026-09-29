import { STD_TYPES, type StdType } from '../enums.js';

/**
 * 표준 타입 3분할 규칙(설계서 §5.7 E_TYPE_LEN_MISSING·E_TYPE_LEN_RANGE, §6.3). 서버의 타입 파서(R16)·도메인분류·도메인·
 * 기본컬럼 저장·엑셀 행 검증과 화면의 즉시 검사가 같은 구현을 쓴다(규칙 이중 구현 금지, §2.5.9).
 */
export const STD_TYPE_SET: ReadonlySet<string> = new Set(STD_TYPES);
/** 길이(정밀도)가 필수인 타입. */
export const LENGTH_REQUIRED_TYPES: ReadonlySet<StdType> = new Set(['VARCHAR', 'CHAR', 'NUMERIC']);
/** 길이를 가질 수 있는 타입(TIMESTAMP는 소수 초 자릿수 0~6). */
export const LENGTH_ALLOWED_TYPES: ReadonlySet<StdType> = new Set([
  'VARCHAR',
  'CHAR',
  'NUMERIC',
  'TIMESTAMP',
]);

export type StdTypePartsProblem = 'LEN_MISSING' | 'LEN_RANGE' | 'SCALE_NOT_ALLOWED';

export function isStdType(v: unknown): v is StdType {
  return typeof v === 'string' && STD_TYPE_SET.has(v);
}

/**
 * (타입, 길이, 스케일) 검사: VARCHAR/CHAR/NUMERIC 길이 필수, 길이 ≥ 1(TIMESTAMP는 0~6), 스케일은 NUMERIC만·≤ 정밀도,
 * 그 외 타입은 길이 없음. 문제가 없으면 null.
 */
export function checkStdTypeParts(
  type: StdType,
  length: number | null,
  scale: number | null,
): StdTypePartsProblem | null {
  if (length === null && LENGTH_REQUIRED_TYPES.has(type)) return 'LEN_MISSING';
  if (length !== null && !LENGTH_ALLOWED_TYPES.has(type)) return 'SCALE_NOT_ALLOWED';
  if (scale !== null && type !== 'NUMERIC') return 'SCALE_NOT_ALLOWED';
  if (type === 'TIMESTAMP') {
    if (length !== null && (length < 0 || length > 6)) return 'LEN_RANGE';
  } else if (length !== null && length < 1) {
    return 'LEN_RANGE';
  }
  if (scale !== null && (scale < 0 || (length !== null && scale > length))) return 'LEN_RANGE';
  return null;
}

/** 검사 결과 → §5.7 코드·메시지. */
export function stdTypeProblemIssue(
  p: StdTypePartsProblem,
  type: StdType,
): { code: 'E_TYPE_LEN_MISSING' | 'E_TYPE_LEN_RANGE'; message: string } {
  switch (p) {
    case 'LEN_MISSING':
      return { code: 'E_TYPE_LEN_MISSING', message: `${type} 길이가 없습니다` };
    case 'SCALE_NOT_ALLOWED':
      return {
        code: 'E_TYPE_LEN_RANGE',
        message:
          type === 'VARCHAR' || type === 'CHAR' || type === 'TIMESTAMP'
            ? `${type}에는 스케일을 쓸 수 없습니다`
            : `${type}에는 길이·스케일을 쓸 수 없습니다`,
      };
    case 'LEN_RANGE':
      return {
        code: 'E_TYPE_LEN_RANGE',
        message:
          type === 'TIMESTAMP'
            ? 'TIMESTAMP 소수 초 자릿수는 0~6입니다'
            : '길이 범위 오류(길이 ≥ 1, 스케일 ≤ 정밀도)',
      };
  }
}

/**
 * 표시·DDL 미리보기용 타입 텍스트(L1 9단계, §5.2). 저장은 항상 3분할.
 * VARCHAR/CHAR → `T(n)`, NUMERIC → `T(p,s)`(s 없으면 `T(p)`), TIMESTAMP → n이 있으면 `T(n)`, 그 외 타입명.
 */
export function typeText(
  type: StdType | string | null | undefined,
  length: number | null | undefined,
  scale: number | null | undefined,
): string | null {
  if (!type) return null;
  const n = length ?? null;
  const sc = scale ?? null;
  switch (type) {
    case 'VARCHAR':
    case 'CHAR':
      return n !== null ? `${type}(${n})` : type;
    case 'NUMERIC':
      if (n === null) return type;
      return sc !== null ? `${type}(${n},${sc})` : `${type}(${n})`;
    case 'TIMESTAMP':
      return n !== null ? `${type}(${n})` : type;
    default:
      return type;
  }
}
