import {
  API_ERROR_CODES,
  checkStdTypeParts,
  DOMAIN_PHYSICAL_RE,
  STD_WARNING_CODES,
  stdTypeProblemIssue,
  typeText,
  type DomainPiece,
  type StdType,
  type TypeSource,
  type ValidationIssue,
} from '@termflow/shared';
import {
  calculateDomain,
  L1_PHYSICAL_MAX,
  type L1Snapshot,
} from '../autocomplete/domain-calculator.js';

/**
 * 도메인 저장 계획(순수 함수, T6.4·T6.9). 도메인 등록·수정 API, 엑셀 일괄 등록 미리보기·적용, 재계산이 같이 쓴다.
 * L1(§5.2) 결과를 저장 규칙으로 바꾼다:
 *  - 미등록 조각·물리명 형식/63자 위반 → physical NULL + review(R15, §5.2 예 "건마찰정보")
 *  - AUTO: 접미어의 도메인분류 타입(없으면 NULL + review) · MANUAL: 입력 타입 유지(필수·길이 규칙 422)
 *  - domain_cls_id는 접미어로 연결(MANUAL이어도 연결 — 승계 R5-b와 같은 규칙)
 */
export interface DomainPlanInput {
  nm: readonly (string | null | undefined)[];
  typeSource: TypeSource;
  colType: StdType | null;
  colLength: number | null;
  colScale: number | null;
}

export interface DomainPlan {
  nm: (string | null)[];
  logicalNm: string;
  physicalNm: string | null;
  assembledPhysical: string;
  descr: string;
  suffix: string | null;
  domainClsId: number | null;
  colType: StdType | null;
  colLength: number | null;
  colScale: number | null;
  typeText: string | null;
  typeSource: TypeSource;
  reviewYn: boolean;
  reviewNote: string | null;
  reviewReasons: string[];
  pieces: DomainPiece[];
  notFound: string[];
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

const NM_SLOTS = 7;

/** nm1..nm7 정리: trim, 빈 값 null(순서 유지, 7칸 고정). */
export function normalizeNm(nm: readonly (string | null | undefined)[]): (string | null)[] {
  const out: (string | null)[] = [];
  for (let i = 0; i < NM_SLOTS; i++) {
    const t = (nm[i] ?? '').trim();
    out.push(t === '' ? null : t);
  }
  return out;
}

export function isValidDomainPhysical(p: string): boolean {
  return p.length <= L1_PHYSICAL_MAX && DOMAIN_PHYSICAL_RE.test(p);
}

export function planDomain(input: DomainPlanInput, snap: L1Snapshot): DomainPlan {
  const nm = normalizeNm(input.nm);
  const l1 = calculateDomain({ parts: nm, typeSource: input.typeSource }, snap);
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const reasons: string[] = [];

  // 명칭 1 필수(std_domain.nm1 NOT NULL) — 비어 있으면 조각 전체가 비어 있는 경우도 포함
  if (nm[0] === null) {
    errors.push({
      code: 'E_DOMAIN_PARTS_EMPTY',
      target: 'field',
      field: 'nm1',
      message: API_ERROR_CODES.E_DOMAIN_PARTS_EMPTY,
    });
  }

  // 물리명
  let physicalNm: string | null = null;
  if (l1.notFound.length > 0) {
    const uniq = [...new Set(l1.notFound)];
    reasons.push(`미등록 조각: ${uniq.join(', ')}`);
    warnings.push({
      code: 'W_TERM_UNREGISTERED',
      target: 'field',
      field: 'nm',
      message: `${STD_WARNING_CODES.W_TERM_UNREGISTERED} — ${uniq.join(', ')}`,
    });
  } else if (l1.parts.length > 0) {
    if (isValidDomainPhysical(l1.physicalNm)) physicalNm = l1.physicalNm;
    else {
      reasons.push(`물리명 형식·길이 위반: ${l1.physicalNm}`);
      warnings.push({
        code: 'W_PHYS_LEN',
        target: 'field',
        field: 'physicalNm',
        message: `${STD_WARNING_CODES.W_PHYS_LEN} (${l1.physicalNm.length}자)`,
      });
    }
  }

  // 접미어·분류 연결
  const suffixPiece = [...l1.pieces].reverse().find((p) => !p.numeric);
  const suffix = suffixPiece && suffixPiece.matched ? l1.suffix : null;
  const cls = suffix !== null ? snap.clsBySuffix.get(suffix) : undefined;

  // 타입
  let colType: StdType | null = null;
  let colLength: number | null = null;
  let colScale: number | null = null;
  if (input.typeSource === 'MANUAL') {
    if (input.colType === null) {
      errors.push({
        code: 'E_TYPE_MISSING',
        target: 'field',
        field: 'colType',
        message: '수기 타입을 지정하세요',
      });
    } else {
      const p = checkStdTypeParts(input.colType, input.colLength, input.colScale);
      if (p)
        errors.push({
          ...stdTypeProblemIssue(p, input.colType),
          target: 'field',
          field: 'colLength',
        });
      colType = input.colType;
      colLength = input.colLength;
      colScale = input.colScale;
    }
  } else if (cls) {
    colType = cls.colType;
    colLength = cls.colLength;
    colScale = cls.colScale;
  } else if (l1.parts.length > 0) {
    const why =
      suffixPiece === undefined
        ? '접미어 없음'
        : suffixPiece.matched
          ? `접미어 ${l1.suffix} 미등록`
          : `접미어 조각 '${suffixPiece.kor}' 미등록`;
    reasons.push(why);
    warnings.push({
      code: 'W_SUFFIX_UNREGISTERED',
      target: 'field',
      field: 'suffix',
      message: `${STD_WARNING_CODES.W_SUFFIX_UNREGISTERED} — ${why}`,
    });
  }

  return {
    nm,
    logicalNm: l1.logicalNm,
    physicalNm,
    assembledPhysical: l1.physicalNm,
    descr: l1.descr,
    suffix,
    domainClsId: cls?.domainClsId ?? null,
    colType,
    colLength,
    colScale,
    typeText: typeText(colType, colLength, colScale),
    typeSource: input.typeSource,
    reviewYn: reasons.length > 0,
    reviewNote: reasons.length > 0 ? reasons.join('; ').slice(0, 500) : null,
    reviewReasons: reasons,
    pieces: l1.pieces.map((p) => ({ ...p })),
    notFound: [...l1.notFound],
    errors,
    warnings,
  };
}

// ── 재계산(POST P/standards/domains/recalculate, §4.8·§11.5 정정 후 재계산) ──────────────
/** 저장된 도메인 1행(재계산 입력). */
export interface StoredDomain {
  domainId: number;
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

export type RecalcFields = Pick<
  StoredDomain,
  | 'physicalNm'
  | 'descr'
  | 'suffix'
  | 'domainClsId'
  | 'colType'
  | 'colLength'
  | 'colScale'
  | 'reviewYn'
  | 'reviewNote'
>;

export interface RecalcResult {
  next: RecalcFields;
  changes: Record<string, [unknown, unknown]>;
}

/** 재계산으로 풀 수 없어 사람이 고쳐야 하는 검토 사유(승계 R5·R5-b "자동 수정 없음", CR-03 C7). */
const KEEP_NOTE_RE = /(수기 타입 해석 불가|원본 타입 해석 불가)[^;/]*/g;

/**
 * 재계산 규칙(CR-05 C4):
 *  - 조각 연결 ≠ 저장 논리명이면 계산 결과를 쓰지 않고 검토 유지(승계 CR-03 C6과 같은 태도)
 *  - 물리명: 비어 있으면 L1으로 채운다. 이미 있으면 유지(승계 원본 물리명 보존) — 단, 복사 후 C3 불일치로 표시된 행은
 *    새 프로젝트 용어 기준 L1 결과로 바꾼다(C3의 의미가 "이 프로젝트 용어로는 결과가 다르다"이므로)
 *  - 타입: AUTO는 접미어 조각이 등록된 경우에만 도메인분류 타입, MANUAL은 유지(§4.8)
 *  - 분류 연결: 계산 접미어(없으면 저장 접미어)의 도메인분류
 *  - 검토: 물리명 없음·타입 없음·조각 불일치·사람이 고칠 사유가 남으면 유지, 모두 풀리면 해제
 */
export function recalcDomain(d: StoredDomain, snap: L1Snapshot): RecalcResult {
  const plan = planDomain(
    {
      nm: d.nm,
      typeSource: d.typeSource,
      colType: d.colType,
      colLength: d.colLength,
      colScale: d.colScale,
    },
    snap,
  );
  const keep = [...(d.reviewNote ?? '').matchAll(KEEP_NOTE_RE)].map((m) => m[0].trim());
  const next: RecalcFields = {
    physicalNm: d.physicalNm,
    descr: d.descr,
    suffix: d.suffix,
    domainClsId: d.domainClsId,
    colType: d.colType,
    colLength: d.colLength,
    colScale: d.colScale,
    reviewYn: d.reviewYn,
    reviewNote: d.reviewNote,
  };
  const reasons: string[] = [];
  if (plan.logicalNm.toUpperCase() !== d.logicalNm.toUpperCase()) {
    // 계산 결과를 신뢰할 수 없다: 검토 행은 사유를 남기고, 검토가 아닌 행(승계 원본 값)은 건드리지 않는다
    if (!d.reviewYn) return { next, changes: {} };
    reasons.push(`명칭 조각과 논리명 불일치: ${plan.logicalNm} ≠ ${d.logicalNm}`);
  } else {
    const c3 = (d.reviewNote ?? '').startsWith('C3:');
    if (d.physicalNm === null || (c3 && plan.physicalNm !== null)) {
      next.physicalNm = plan.physicalNm;
      if (plan.physicalNm !== null) next.descr = plan.descr;
    }
    if (next.physicalNm === null) {
      reasons.push(plan.reviewReasons.find((r) => !r.startsWith('접미어')) ?? '물리명 없음');
    }
    next.suffix = plan.suffix ?? d.suffix;
    const cls = next.suffix !== null ? snap.clsBySuffix.get(next.suffix) : undefined;
    next.domainClsId = cls?.domainClsId ?? null;
    if (d.typeSource === 'AUTO') {
      if (plan.colType !== null) {
        next.colType = plan.colType;
        next.colLength = plan.colLength;
        next.colScale = plan.colScale;
      } else if (d.colType === null) {
        // 접미어 분류를 찾지 못하면 저장 타입을 지우지 않는다(원본 타입 보존) — 타입이 없을 때만 검토
        reasons.push(plan.reviewReasons.find((r) => r.startsWith('접미어')) ?? '타입 없음');
      }
    } else if (d.colType === null) {
      reasons.push('수기 타입 없음');
    }
  }
  for (const k of keep) if (!reasons.includes(k)) reasons.push(k);
  next.reviewYn = reasons.length > 0;
  next.reviewNote = reasons.length > 0 ? reasons.join('; ').slice(0, 500) : null;

  // 검토 여부가 그대로이고 사유 문구만 달라지면(승계 문구 ↔ 재계산 문구) 행을 바꾸지 않는다(불필요한 갱신·감사 방지)
  const onlyWording = (Object.keys(next) as (keyof RecalcFields)[]).every(
    (k) => k === 'reviewNote' || next[k] === d[k],
  );
  if (onlyWording && next.reviewYn === d.reviewYn && next.reviewYn) next.reviewNote = d.reviewNote;

  const changes: Record<string, [unknown, unknown]> = {};
  for (const k of Object.keys(next) as (keyof RecalcFields)[]) {
    if (next[k] !== d[k]) changes[k] = [d[k], next[k]];
  }
  return { next, changes };
}

/** 계획 → std_domain insert/update 값(감사 컬럼 제외). */
export function planFields(p: DomainPlan) {
  const [nm1, nm2, nm3, nm4, nm5, nm6, nm7] = p.nm;
  return {
    nm1: nm1 ?? '',
    nm2: nm2 ?? null,
    nm3: nm3 ?? null,
    nm4: nm4 ?? null,
    nm5: nm5 ?? null,
    nm6: nm6 ?? null,
    nm7: nm7 ?? null,
    logicalNm: p.logicalNm,
    physicalNm: p.physicalNm,
    descr: p.descr,
    suffix: p.suffix,
    domainClsId: p.domainClsId,
    colType: p.colType,
    colLength: p.colLength,
    colScale: p.colScale,
    typeSource: p.typeSource,
    reviewYn: p.reviewYn,
    reviewNote: p.reviewNote,
  };
}
