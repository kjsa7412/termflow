import { parseStdType, type StdTypeParseResult } from '@termflow/shared';

/**
 * 표준 타입 3분할 파서(R16, 설계서 §11.2·§6.3). 구현은 `@termflow/shared`(`parseStdType`·`splitStdType`)로 옮겨
 * 승계 러너(R3·R5·R10·R14·R16)·엑셀 입력(서버)과 편집기 타입 셀(화면, T8.8)이 같은 규칙을 쓴다(CR-07 C11).
 * 이 파일은 기존 import 경로를 유지하는 재수출 + 서버 전용 조합 함수만 둔다.
 */
export {
  parseStdType,
  splitStdType,
  typeText,
  type StdTypeParts,
  type StdTypeParseFailure,
  type StdTypeParseResult,
} from '@termflow/shared';

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
