import { checkStdTypeParts, STD_TYPES, typeText, type StdType } from '@termflow/shared';

/**
 * 표준 타입 3분할 파서(R16, 설계서 §11.2·§6.3). 승계 러너(R3·R5·R10·R14·R16)와 이후 편집기·엑셀 입력이 같이 쓴다.
 *
 * 정규식(§11.2 R16): `^([A-Z]+)(?:\((\d+)(?:\.0)?(?:,(\d+))?\))?$` → (type, length, scale).
 *  - `VARCHAR(5.0)` → VARCHAR, 5 (소수 표기 흡수)
 *  - `INTEGER` → INT, `TIMESTAMP`(n 없음) → length NULL
 *  - 별칭(CR-03 C2): `VARCHAR2` → VARCHAR(승계 도메인 수기 타입에 Oracle 표기가 섞여 있음)
 * 파싱 전 정리: trim, 대문자, 공백 제거(`NUMERIC(13, 2)` 허용).
 */
const TYPE_RE = /^([A-Z][A-Z0-9]*)(?:\((\d+)(?:\.0)?(?:,(\d+))?\))?$/;

const ALIASES: Readonly<Record<string, StdType>> = {
  INTEGER: 'INT',
  VARCHAR2: 'VARCHAR',
};

const STD_TYPE_SET: ReadonlySet<string> = new Set(STD_TYPES);

export interface StdTypeParts {
  type: StdType;
  length: number | null;
  scale: number | null;
}

export type StdTypeParseFailure =
  'EMPTY' | 'FORMAT' | 'UNKNOWN_TYPE' | 'LEN_MISSING' | 'LEN_RANGE' | 'SCALE_NOT_ALLOWED';

export type StdTypeParseResult =
  | ({ ok: true; normalized: string } & StdTypeParts)
  | { ok: false; reason: StdTypeParseFailure; input: string };

/**
 * 타입 문자열 → 3분할. 구조만이 아니라 표준 규칙(§5.7 E_TYPE_LEN_MISSING·E_TYPE_LEN_RANGE)도 검사한다:
 * VARCHAR/CHAR/NUMERIC 길이 필수, 길이 ≥ 1, NUMERIC scale ≤ precision, TIMESTAMP n ≤ 6, 그 외 타입은 길이 없음.
 */
export function parseStdType(input: string | null | undefined): StdTypeParseResult {
  const raw = input ?? '';
  const s = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (s === '') return { ok: false, reason: 'EMPTY', input: raw };
  const m = TYPE_RE.exec(s);
  if (!m) return { ok: false, reason: 'FORMAT', input: raw };
  const name = m[1]!;
  const type = (ALIASES[name] ?? (STD_TYPE_SET.has(name) ? name : null)) as StdType | null;
  if (!type) return { ok: false, reason: 'UNKNOWN_TYPE', input: raw };
  const length = m[2] !== undefined ? Number(m[2]) : null;
  const scale = m[3] !== undefined ? Number(m[3]) : null;
  return checkParts({ type, length, scale }, raw);
}

/** 이미 분리된 값(타입 + 길이 문자열)을 검사한다. R3: 도메인분류·도메인의 `col_type`·`col_length`. */
export function parseTypeAndLength(
  colType: string | null | undefined,
  colLength: string | null | undefined,
): StdTypeParseResult {
  const len = (colLength ?? '').trim();
  if (len === '') return parseStdType(colType);
  const t = (colType ?? '').trim();
  // col_type에 이미 괄호가 있으면(TIMESTAMP(0)) 길이 문자열과 동시에 올 수 없다.
  if (t.includes('(')) return { ok: false, reason: 'FORMAT', input: `${t}|${len}` };
  return parseStdType(`${t}(${len})`);
}

function checkParts(p: StdTypeParts, raw: string): StdTypeParseResult {
  const { type, length, scale } = p;
  const problem = checkStdTypeParts(type, length, scale);
  if (problem) return { ok: false, reason: problem, input: raw };
  return { ok: true, type, length, scale, normalized: typeText(type, length, scale) ?? type };
}

/** 표시·DDL 미리보기용 타입 텍스트(L1 9단계) — 규칙은 `@termflow/shared`(화면과 공유). */
export { typeText };
