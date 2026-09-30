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
 * 표준 타입 3분할 파서(R16, 설계서 §11.2·§6.3) — 승계 러너·엑셀 입력(서버)과 편집기 타입 셀(화면, T8.8)이 같은 구현을 쓴다.
 * 정규식(§11.2 R16): `^([A-Z]+)(?:\((\d+)(?:\.0)?(?:,(\d+))?\))?$` → (type, length, scale).
 *  - `VARCHAR(5.0)` → VARCHAR, 5 (소수 표기 흡수) · `INTEGER` → INT · `TIMESTAMP`(n 없음) → length NULL
 *  - 별칭(CR-03 C2): `VARCHAR2` → VARCHAR
 * 파싱 전 정리: trim, 대문자, 공백 제거(`NUMERIC(13, 2)` 허용).
 */
const TYPE_RE = /^([A-Z][A-Z0-9]*)(?:\((\d+)(?:\.0)?(?:,(\d+))?\))?$/;
const TYPE_ALIASES: Readonly<Record<string, StdType>> = { INTEGER: 'INT', VARCHAR2: 'VARCHAR' };

export interface StdTypeParts {
  type: StdType;
  length: number | null;
  scale: number | null;
}
export type StdTypeParseFailure = 'EMPTY' | 'FORMAT' | 'UNKNOWN_TYPE' | StdTypePartsProblem;
export type StdTypeParseResult =
  | ({ ok: true; normalized: string } & StdTypeParts)
  | { ok: false; reason: StdTypeParseFailure; input: string };
export type StdTypeSplitResult =
  | ({ ok: true } & StdTypeParts)
  | { ok: false; reason: 'EMPTY' | 'FORMAT' | 'UNKNOWN_TYPE'; input: string };

/** 구조만 분리(길이 규칙 검사 없음). 편집기는 `VARCHAR`처럼 길이가 빠진 입력도 타입으로 받아 두고 E_TYPE_LEN_*로 보여 준다. */
export function splitStdType(input: string | null | undefined): StdTypeSplitResult {
  const raw = input ?? '';
  const s = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (s === '') return { ok: false, reason: 'EMPTY', input: raw };
  const m = TYPE_RE.exec(s);
  if (!m) return { ok: false, reason: 'FORMAT', input: raw };
  const name = m[1]!;
  const type = TYPE_ALIASES[name] ?? (STD_TYPE_SET.has(name) ? (name as StdType) : null);
  if (!type) return { ok: false, reason: 'UNKNOWN_TYPE', input: raw };
  return {
    ok: true,
    type,
    length: m[2] !== undefined ? Number(m[2]) : null,
    scale: m[3] !== undefined ? Number(m[3]) : null,
  };
}

/**
 * 타입 문자열 → 3분할 + 표준 규칙(§5.7 E_TYPE_LEN_MISSING·E_TYPE_LEN_RANGE): VARCHAR/CHAR/NUMERIC 길이 필수, 길이 ≥ 1,
 * NUMERIC scale ≤ precision, TIMESTAMP n ≤ 6, 그 외 타입은 길이 없음.
 */
export function parseStdType(input: string | null | undefined): StdTypeParseResult {
  const r = splitStdType(input);
  if (!r.ok) return r;
  const problem = checkStdTypeParts(r.type, r.length, r.scale);
  if (problem) return { ok: false, reason: problem, input: input ?? '' };
  return { ...r, normalized: typeText(r.type, r.length, r.scale) ?? r.type };
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
