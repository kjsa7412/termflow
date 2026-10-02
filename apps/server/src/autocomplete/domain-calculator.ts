import type { StdType, TypeSource } from '@termflow/shared';
import { typeText } from '../standard/std-type-parser.js';

/**
 * L1 — 도메인 자동계산 규칙(설계서 §5.2, 10단계). **순수 함수**: 입력 스냅샷 인터페이스에만 의존하고
 * DB·Nest를 모른다. 승계 러너(R5·R15), 복사 엔진 C3 재검증(단계 5), 도메인 CRUD 미리보기(단계 6),
 * 자동완성 조립(단계 9)이 같은 구현을 쓴다(규칙 이중 구현 금지, §2.5.9).
 */

/** 용어 스냅샷 1행(한글 용어 → 물리약어). physical NULL이면 미등록과 같게 본다(§5.2 3단계). */
export interface TermEntry {
  readonly physical: string | null;
  readonly termId?: number;
}

/** 도메인분류 스냅샷 1행(접미어 → 표준 타입). */
export interface DomainClsEntry {
  readonly domainClsId: number | null;
  readonly colType: StdType;
  readonly colLength: number | null;
  readonly colScale: number | null;
}

/** L1 입력 스냅샷(프로젝트 1개 분량). 러너는 승계 템플릿 메모리 스냅샷, 서버는 TermCache가 제공한다. */
export interface L1Snapshot {
  readonly termByKor: ReadonlyMap<string, TermEntry>;
  readonly clsBySuffix: ReadonlyMap<string, DomainClsEntry>;
  /** 같은 프로젝트에 이 논리명의 도메인이 이미 있는지(10단계 유니크 검사). 없으면 검사 생략. */
  readonly logicalExists?: (logicalNm: string) => boolean;
}

export interface L1Input {
  /** 명칭 조각 nm1..nm7(빈 값·NULL은 건너뜀). */
  readonly parts: readonly (string | null | undefined)[];
  /** MANUAL이면 8~9단계(타입) 생략 — 호출자가 기존 수기 타입을 유지한다. */
  readonly typeSource?: TypeSource;
}

export type L1IssueCode =
  | 'E_DOMAIN_LOGICAL_DUP'
  | 'E_DOMAIN_PARTS_EMPTY'
  | 'W_PHYS_LEN'
  | 'W_TERM_UNREGISTERED'
  | 'W_SUFFIX_UNREGISTERED';

export interface L1Issue {
  readonly code: L1IssueCode;
  readonly severity: 'E' | 'W';
  readonly message: string;
}

export interface L1Result {
  /** 정리된 조각(trim, 라틴 대문자). */
  readonly parts: readonly string[];
  readonly logicalNm: string;
  /**
   * 조립된 물리명. 미등록 조각은 `upper(part)` fallback이라 한글이 남을 수 있다(형식 CHECK 위반) →
   * 저장 여부는 호출자가 `notFound`로 판정한다(R15: notFound가 있으면 NULL + review).
   */
  readonly physicalNm: string;
  readonly descr: string;
  readonly suffix: string | null;
  readonly domainClsId: number | null;
  readonly colType: StdType | null;
  readonly colLength: number | null;
  readonly colScale: number | null;
  readonly typeText: string | null;
  /** 미등록(또는 physical NULL) 조각, 입력 순서·중복 유지. */
  readonly notFound: readonly string[];
  readonly issues: readonly L1Issue[];
  /** 조각별 결과(화면의 조각 배지·미리보기): 한글 조각, 물리약어(미등록이면 upper fallback), 등록 여부, 숫자 여부. */
  readonly pieces: readonly L1Piece[];
}

export interface L1Piece {
  readonly kor: string;
  readonly physical: string;
  readonly matched: boolean;
  readonly numeric: boolean;
}

/** 식별자 길이 상한(PostgreSQL, §5.7). */
export const L1_PHYSICAL_MAX = 63;

/** 2단계 숫자 판정: 정수 0~10(`'1.0'` 같은 소수 표기는 숫자가 아니다 — R1 정규화가 전제). */
export function isNumPart(part: string): boolean {
  return /^(10|[0-9])$/.test(part);
}

/** 1단계 조각 정리: trim, 빈 값 제거, 라틴 문자 대문자(용어 'id' → 'ID'). */
export function normalizeParts(parts: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const p of parts) {
    const t = (p ?? '').trim();
    if (t === '') continue;
    out.push(t.replace(/[a-z]+/g, (m) => m.toUpperCase()));
  }
  return out;
}

export function calculateDomain(input: L1Input, snap: L1Snapshot): L1Result {
  const parts = normalizeParts(input.parts);
  const issues: L1Issue[] = [];
  const notFound: string[] = [];

  if (parts.length === 0) {
    issues.push({
      code: 'E_DOMAIN_PARTS_EMPTY',
      severity: 'E',
      message: '명칭 조각이 비어 있습니다',
    });
  }

  // 3단계 용어 조회 → 조각별 물리약어
  const pieces: L1Piece[] = [];
  const phys = parts.map((part) => {
    if (isNumPart(part)) {
      pieces.push({ kor: part, physical: part, matched: true, numeric: true });
      return part;
    }
    const term = snap.termByKor.get(part);
    if (!term || term.physical === null || term.physical === '') {
      notFound.push(part);
      pieces.push({ kor: part, physical: part.toUpperCase(), matched: false, numeric: false });
      return part.toUpperCase();
    }
    pieces.push({ kor: part, physical: term.physical, matched: true, numeric: false });
    return term.physical;
  });

  // 4~6단계 논리명·물리명·설명
  const join = (list: readonly string[]) =>
    list.map((piece, i) => (i === 0 || isNumPart(parts[i]!) ? piece : `_${piece}`)).join('');
  const logicalNm = parts.join('');
  const physicalNm = join(phys);
  const descr = join(parts);

  // 7단계 접미어: 마지막 비숫자 조각의 phys
  let suffix: string | null = null;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!isNumPart(parts[i]!)) {
      suffix = phys[i]!;
      break;
    }
  }

  // 8~9단계 타입
  let domainClsId: number | null = null;
  let colType: StdType | null = null;
  let colLength: number | null = null;
  let colScale: number | null = null;
  if (input.typeSource !== 'MANUAL') {
    const cls = suffix !== null ? snap.clsBySuffix.get(suffix) : undefined;
    if (cls) {
      domainClsId = cls.domainClsId;
      colType = cls.colType;
      colLength = cls.colLength;
      colScale = cls.colScale;
    } else {
      issues.push({
        code: 'W_SUFFIX_UNREGISTERED',
        severity: 'W',
        message: suffix !== null ? `접미어 ${suffix} 미등록` : '접미어 없음(모든 조각이 숫자)',
      });
    }
  }

  // 10단계 검증
  if (logicalNm !== '' && snap.logicalExists?.(logicalNm)) {
    issues.push({
      code: 'E_DOMAIN_LOGICAL_DUP',
      severity: 'E',
      message: `같은 논리명의 도메인이 있습니다: ${logicalNm}`,
    });
  }
  if (physicalNm.length > L1_PHYSICAL_MAX) {
    issues.push({
      code: 'W_PHYS_LEN',
      severity: 'W',
      message: `물리명이 ${L1_PHYSICAL_MAX}자를 초과합니다(${physicalNm.length}자)`,
    });
  }
  if (notFound.length > 0) {
    issues.push({
      code: 'W_TERM_UNREGISTERED',
      severity: 'W',
      message: `미등록 조각: ${[...new Set(notFound)].join(', ')}`,
    });
  }

  return {
    parts,
    logicalNm,
    physicalNm,
    descr,
    suffix,
    domainClsId,
    colType,
    colLength,
    colScale,
    typeText: typeText(colType, colLength, colScale),
    notFound,
    issues,
    pieces,
  };
}
