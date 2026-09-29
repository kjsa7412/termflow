import type { ValidationIssue } from '../api/problem.js';
import { TERM_PHYSICAL_RE } from './identifier.js';
import { API_ERROR_CODES } from './codes.js';

/**
 * 표준 사전 입력 규칙(설계서 §3.5.5~§3.5.6·§4.5·§9.4 행 검증). 서버 API(422)·엑셀 미리보기 행 검증·화면 즉시 검사가 같이 쓴다.
 */

/** 한글 용어 정규화: trim, 라틴 문자는 대문자(§3.5.5 "라틴 문자는 대문자 저장", L1 1단계와 같은 규칙). */
export function normalizeTermKor(v: string): string {
  return v.trim().replace(/[a-z]+/g, (m) => m.toUpperCase());
}

/** 물리약어·접미어 정규화: trim만(대소문자 자동 변환 없음 — 소문자는 형식 오류로 알린다). 빈 문자열은 null. */
export function normalizeAbbr(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
}

function issue(
  code: keyof typeof API_ERROR_CODES,
  field: string,
  message?: string,
): ValidationIssue {
  return { code, target: 'field', field, message: message ?? API_ERROR_CODES[code] };
}

/** 용어 한글·물리약어 검사(형식 오류 = 422 E_TERM_*). 물리약어는 필수(용어 사전 등록 경로는 모두 물리약어를 요구). */
export function validateTermFields(
  termKor: string,
  termPhysical: string | null,
): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  if (termKor === '') out.push(issue('E_TERM_KOR_EMPTY', 'termKor'));
  else if (termKor.length > 100) out.push(issue('E_TERM_KOR_LEN', 'termKor'));
  if (termPhysical === null) out.push(issue('E_TERM_PHYSICAL_EMPTY', 'termPhysical'));
  else if (!TERM_PHYSICAL_RE.test(termPhysical))
    out.push(
      issue(
        'E_TERM_PHYSICAL_FORMAT',
        'termPhysical',
        `물리약어 '${termPhysical}'에 허용되지 않는 문자가 있습니다(영대문자·숫자·_만)`,
      ),
    );
  else if (termPhysical.length > 30) out.push(issue('E_TERM_PHYSICAL_LEN', 'termPhysical'));
  return out;
}

/** 접미어 검사(도메인분류 키, §3.5.6 CHECK `^[A-Z0-9_]+$`, 30자). */
export function validateSuffix(suffix: string | null): ValidationIssue[] {
  if (suffix === null) return [issue('E_SUFFIX_EMPTY', 'suffix')];
  if (!TERM_PHYSICAL_RE.test(suffix) || suffix.length > 30)
    return [
      issue(
        'E_SUFFIX_FORMAT',
        'suffix',
        `접미어 '${suffix}'는 영대문자·숫자·_ 30자 이내여야 합니다`,
      ),
    ];
  return [];
}
