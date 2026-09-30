import {
  AUTOCOMPLETE_ALTERNATIVES_MAX,
  AUTOCOMPLETE_SIMILAR_MAX,
  CODE_CANDIDATES_MAX,
  formatValidationMessage,
  typeText,
  type AutocompleteApplied,
  type AutocompleteCandidate,
  type AutocompleteCodeCandidate,
  type AutocompleteResponse,
  type AutocompleteSegment,
  type TableNameSuggestion,
  type ValidationCode,
  type ValidationIssue,
} from '@termflow/shared';
import { calculateDomain } from './domain-calculator.js';
import { joinPhysical, segmentFull, segmentPartial, suffixOf, type Seg } from './segmenter.js';
import { normalizeLogical, type SnapDomain, type TermSnapshot } from './term-snapshot.js';

/**
 * L2/L3 컬럼 자동완성 파이프라인(설계서 §5.3, T9.3). **순수 함수**(스냅샷 메모리 연산만, DB 왕복 0 — §5.8).
 *   정규화 → ① exact(도메인 논리명 정확일치) → ② 분절(완전 ≤3 / 부분) → ③ similar(도메인 부분 일치 랭킹 ≤5 + 조합 1)
 *   → ④ composed(similar 0 + 완전 분절, 대안 ≤2) → ⑤ unregistered(`?` 표시) → ⑥ 코드성 후보(…코드, ≤3, §5.6)
 * 물리명 조립·접미어·타입은 L1(`calculateDomain`)을 그대로 쓴다(규칙 단일 구현).
 */
export type EngineResult = Omit<AutocompleteResponse, 'cacheVersion' | 'elapsedMs'>;

export interface EngineOptions {
  /** 편집 중 테이블 업무구분(코드성 후보 +10점). */
  bizAreaId?: number | null;
}

const issue = (
  code: ValidationCode,
  params: Record<string, string | number> = {},
): ValidationIssue => ({
  code,
  target: 'column',
  message: formatValidationMessage(code, params),
});

export function toSegments(segs: readonly Seg[]): AutocompleteSegment[] {
  return segs.map((x) =>
    x.kind === 'term'
      ? {
          kor: x.kor,
          physical: x.physical,
          matched: true,
          ...(x.termId !== undefined ? { termId: x.termId } : {}),
          ...(x.status !== undefined ? { status: x.status } : {}),
        }
      : x.kind === 'num'
        ? { kor: x.kor, physical: x.physical, matched: true, numeric: true }
        : { kor: x.kor, physical: null, matched: false },
  );
}

/** 완전 분절 1개 → L1 조립(물리명·접미어·타입). */
function composeOf(segs: readonly Seg[], snap: TermSnapshot) {
  return calculateDomain({ parts: segs.map((x) => x.kor) }, snap);
}

function pendingWarnings(segs: readonly Seg[]): ValidationIssue[] {
  const seen = new Set<string>();
  const out: ValidationIssue[] = [];
  for (const x of segs) {
    if (x.kind === 'term' && x.status === 'PENDING' && !seen.has(x.kor)) {
      seen.add(x.kor);
      out.push(issue('W_TERM_PENDING', { termKor: x.kor }));
    }
  }
  return out;
}

const domainApplied = (d: SnapDomain): AutocompleteApplied => ({
  physicalNm: d.physicalNm!,
  dataType: d.colType,
  dataLength: d.colLength,
  dataScale: d.colScale,
  typeText: d.typeText,
  colComment: d.logicalNm,
  domainId: d.domainId,
  matchType: 'EXACT',
});

/** ③ 유사 후보 점수(§5.3): startsWith 100 + contains 50 + 접미어 일치 20 − 길이 차 + 분류 연결 5. */
export function rankSimilar(
  snap: TermSnapshot,
  s: string,
  segSuffix: string | null,
  opts: { allowWithin?: boolean; limit?: number } = {},
): { d: SnapDomain; score: number }[] {
  const limit = opts.limit ?? AUTOCOMPLETE_SIMILAR_MAX;
  const allowWithin = opts.allowWithin ?? true;
  const out: { d: SnapDomain; score: number }[] = [];
  for (const d of snap.domains) {
    if (d.key === s) continue;
    const contains = d.key.includes(s);
    const within = allowWithin && d.key.length >= 2 && s.includes(d.key);
    if (!contains && !within) continue;
    const score =
      (d.key.startsWith(s) ? 100 : 0) +
      (contains ? 50 : 0) +
      (segSuffix !== null && d.suffix === segSuffix ? 20 : 0) -
      Math.abs(d.key.length - s.length) +
      (d.domainClsId !== null ? 5 : 0);
    out.push({ d, score });
  }
  out.sort(
    (a, b) =>
      b.score - a.score ||
      (a.d.logicalNm < b.d.logicalNm ? -1 : a.d.logicalNm > b.d.logicalNm ? 1 : 0),
  );
  return out.slice(0, limit);
}

/** ⑥ 코드성 후보(§5.6): 정확 100 / base가 코드구분명으로 끝남(≥2자) 60 / 코드구분명이 base 포함 30, 같은 업무구분 +10. */
export function codeCandidates(
  snap: TermSnapshot,
  s: string,
  opts: EngineOptions = {},
): AutocompleteCodeCandidate[] {
  if (!s.endsWith('코드') || s.length <= 2) return [];
  const base = s.slice(0, -2);
  const scored: { c: TermSnapshot['codeClsList'][number]; score: number }[] = [];
  for (const c of snap.codeClsList) {
    let score = 0;
    if (c.key === base) score = 100;
    else if (c.key.length >= 2 && base.endsWith(c.key)) score = 60;
    else if (c.key.includes(base)) score = 30;
    if (score === 0) continue;
    if (opts.bizAreaId != null && c.bizAreaId === opts.bizAreaId) score += 10;
    scored.push({ c, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (a.c.codeClsNm < b.c.codeClsNm ? -1 : a.c.codeClsNm > b.c.codeClsNm ? 1 : 0) ||
      a.c.codeClsId - b.c.codeClsId,
  );
  if (scored.length === 0) return [];
  // 논리명·물리명·타입은 **입력 기준**(CR-08 C5): 정확일치(a)면 설계서의 `{code_cls_nm}코드`와 같고, 부분 일치(b·c)에서
  // 코드구분명으로 바꾸면 입력의 앞부분('연구과제')이 사라진다. 입력이 도메인과 정확일치하면 그 도메인 값·domainId.
  const dom = snap.domainByLogical.get(s);
  const useDom = dom !== undefined && dom.physicalNm !== null;
  const full = segmentFull(s, snap)[0];
  const segs = full ?? segmentPartial(s, snap).segs;
  const l1 = full ? composeOf(full, snap) : null;
  const physicalNm = useDom ? dom.physicalNm! : (l1?.physicalNm ?? joinPhysical(segs));
  const suffix = suffixOf(segs);
  const cls = suffix !== null ? snap.clsBySuffix.get(suffix) : undefined;
  const t = useDom
    ? { dataType: dom.colType, dataLength: dom.colLength, dataScale: dom.colScale }
    : l1
      ? { dataType: l1.colType, dataLength: l1.colLength, dataScale: l1.colScale }
      : {
          dataType: cls?.colType ?? null,
          dataLength: cls?.colLength ?? null,
          dataScale: cls?.colScale ?? null,
        };
  return scored.slice(0, CODE_CANDIDATES_MAX).map(({ c, score }) => ({
    codeClsId: c.codeClsId,
    bizCd: c.bizCd,
    bizNm: c.bizNm,
    codeCls: c.codeCls,
    codeClsNm: c.codeClsNm,
    logicalNm: s,
    physicalNm,
    ...t,
    typeText: typeText(t.dataType, t.dataLength, t.dataScale),
    colComment:
      c.key === base
        ? `${s}(${c.bizCd}/${c.codeCls})`
        : `${s}(${c.bizCd}/${c.codeCls} ${c.codeClsNm})`,
    domainId: useDom ? dom.domainId : null,
    codeCnt: c.codeCnt,
    codes: [...c.codes],
    score,
  }));
}

export function runAutocomplete(
  snap: TermSnapshot,
  input: string,
  opts: EngineOptions = {},
): EngineResult {
  const s = normalizeLogical(input);
  const warnings: ValidationIssue[] = [];
  const codes = codeCandidates(snap, s, opts);
  const withCodes = (r: EngineResult): EngineResult =>
    codes.length > 0 ? { ...r, codeCandidates: codes } : r;

  // ① exact
  const d = snap.domainByLogical.get(s);
  if (d) {
    if (d.reviewYn) warnings.push(issue('W_DOMAIN_REVIEW'));
    if (d.physicalNm !== null) {
      return withCodes({
        type: 'exact',
        input,
        normalized: s,
        applied: domainApplied(d),
        warnings,
      });
    }
  }

  // ② 분절
  const full = segmentFull(s, snap);
  const partial = full.length === 0 ? segmentPartial(s, snap) : null;
  const mainSegs = full[0] ?? partial!.segs;
  const segSuffix = suffixOf(mainSegs);
  const composed = full[0] ? composeOf(full[0], snap) : null;

  // ③ similar — 완전 분절이 있으면 "입력이 도메인 논리명을 포함"(짧은 범용 도메인: '여부'·'내용' 등) 방향은 후보로 보지 않는다.
  //   승계 649 논리명에서 이 방향이 similar의 대부분이었고 첫 후보가 조합보다 틀렸다(CR-08 C3). 분절 실패 시에는 그대로 쓴다.
  const similar = rankSimilar(snap, s, segSuffix, { allowWithin: full.length === 0 });
  if (similar.length > 0) {
    const candidates: AutocompleteCandidate[] = similar.map(({ d: x, score }) => ({
      kind: 'domain',
      domainId: x.domainId,
      logicalNm: x.logicalNm,
      physicalNm: x.physicalNm!,
      dataType: x.colType,
      dataLength: x.colLength,
      dataScale: x.colScale,
      typeText: x.typeText,
      colComment: x.logicalNm,
      score,
      ...(x.reviewYn ? { reviewYn: true } : {}),
    }));
    if (composed && full[0]) {
      candidates.push({
        kind: 'composed',
        logicalNm: s,
        physicalNm: composed.physicalNm,
        dataType: composed.colType,
        dataLength: composed.colLength,
        dataScale: composed.colScale,
        typeText: composed.typeText,
        colComment: s,
        score: 0,
        segments: toSegments(full[0]),
      });
    }
    return withCodes({
      type: 'similar',
      input,
      normalized: s,
      applied: null,
      segments: toSegments(mainSegs),
      candidates,
      warnings: [...warnings, ...pendingWarnings(mainSegs)],
    });
  }

  // ④ composed
  if (composed && full[0]) {
    if (composed.colType === null) {
      warnings.push(issue('W_SUFFIX_UNREGISTERED', { suffix: composed.suffix ?? '' }));
    }
    return withCodes({
      type: 'composed',
      input,
      normalized: s,
      applied: {
        physicalNm: composed.physicalNm,
        dataType: composed.colType,
        dataLength: composed.colLength,
        dataScale: composed.colScale,
        typeText: composed.typeText,
        colComment: s,
        domainId: null,
        matchType: 'COMPOSED',
      },
      segments: toSegments(full[0]),
      alternatives: full.slice(1, 1 + AUTOCOMPLETE_ALTERNATIVES_MAX).map((alt) => ({
        physicalNm: joinPhysical(alt),
        segments: toSegments(alt),
      })),
      warnings: [...warnings, ...pendingWarnings(full[0])],
    });
  }

  // ⑤ unregistered — 매칭 조각까지만의 부분 물리명(미매칭 자리 `?`, 저장 금지)
  const segs = partial!.segs;
  const suffix = suffixOf(segs);
  const cls = suffix !== null ? snap.clsBySuffix.get(suffix) : undefined;
  warnings.push(issue('W_TERM_UNREGISTERED'));
  return withCodes({
    type: 'unregistered',
    input,
    normalized: s,
    applied: {
      physicalNm: joinPhysical(segs),
      dataType: cls?.colType ?? null,
      dataLength: cls?.colLength ?? null,
      dataScale: cls?.colScale ?? null,
      typeText: cls ? typeText(cls.colType, cls.colLength, cls.colScale) : null,
      colComment: s,
      domainId: null,
      matchType: 'UNREGISTERED',
    },
    segments: toSegments(segs),
    registerCandidates: registerCandidates(segs),
    warnings: [...warnings, ...pendingWarnings(segs)],
  });
}

/**
 * 인라인 등록 카드의 한글 용어 후보(CR-08 C7). 부분 분절은 미매칭 글자 수를 최소로 잡으므로 '책임'이 사전에 있으면
 * '연구책임자구분' → [연구][책임][자 ✗][구분]이 된다. 한 글자 미매칭은 대개 앞 조각과 한 낱말(책임+자, 연구+자)이므로
 * "앞 조각 + 미매칭"을 첫 후보로, 미매칭 자체를 다음 후보로 준다. 두 글자 이상이면 미매칭 그대로가 첫 후보.
 */
export function registerCandidates(segs: readonly Seg[]): string[] {
  const i = segs.findIndex((x) => x.kind === 'miss');
  if (i < 0) return [];
  const miss = segs[i]!.kor;
  const prev = i > 0 ? segs[i - 1] : undefined;
  const out: string[] = [];
  if (miss.length === 1 && prev?.kind === 'term') out.push(prev.kor + miss);
  out.push(miss);
  return out;
}

/**
 * 테이블 물리명 제안(§5.5): 업무구분 `table_prefix` + 분절(완전 첫 후보, 실패 시 부분 — 미매칭 `?` + W_TERM_UNREGISTERED).
 * 이미 접두어로 시작하면 중복 부여하지 않는다. 항상 대문자. 중복·형식 검사는 호출자(서비스)가 더한다.
 */
export function suggestTableName(
  snap: TermSnapshot,
  logicalNm: string,
  bizAreaId: number | null,
): Omit<TableNameSuggestion, 'errors' | 'cacheVersion'> {
  const s = normalizeLogical(logicalNm);
  const full = segmentFull(s, snap)[0];
  const segs = full ?? segmentPartial(s, snap).segs;
  const body = joinPhysical(segs).toUpperCase();
  const prefix = bizAreaId !== null ? (snap.bizAreas.get(bizAreaId)?.tablePrefix ?? null) : null;
  const tableNm = prefix && !body.startsWith(prefix) ? `${prefix}${body}` : body;
  const warnings: ValidationIssue[] = [];
  if (!full) {
    warnings.push({
      code: 'W_TERM_UNREGISTERED',
      target: 'table',
      field: 'tableNm',
      message: `미등록 용어가 있어 물리명을 완성하지 못했습니다: ${segs
        .filter((x) => x.kind === 'miss')
        .map((x) => x.kor)
        .join(', ')}`,
    });
  }
  return { tableNm, prefix, segments: toSegments(segs), complete: full !== undefined, warnings };
}

/** 재검증 힌트(§4.8, T9.9): 조각 중 PENDING·REJECTED 용어, 재분절 물리명(COMPOSED·UNREGISTERED 컬럼만 W_TERM_CHANGED). */
export interface ColumnTermHint {
  pending: string[];
  rejected: string[];
  resegmented: string | null;
}

export function columnTermHint(
  snap: TermSnapshot,
  col: { logicalNm: string; physicalNm: string; matchType: string; defaultColId: number | null },
): ColumnTermHint | undefined {
  if (col.defaultColId !== null) return undefined;
  if (col.matchType !== 'COMPOSED' && col.matchType !== 'UNREGISTERED') return undefined;
  const s = normalizeLogical(col.logicalNm);
  if (s === '') return undefined;
  const full = segmentFull(s, snap);
  if (full.length > 0) {
    const phys = full.map((f) => joinPhysical(f));
    const pending = [
      ...new Set(
        full[0]!.flatMap((x) => (x.kind === 'term' && x.status === 'PENDING' ? [x.kor] : [])),
      ),
    ];
    return {
      pending,
      rejected: [],
      // 대안 분절 중 하나를 골라 저장했으면 바뀐 것이 아니다
      resegmented: phys.includes(col.physicalNm) ? col.physicalNm : phys[0]!,
    };
  }
  const part = segmentPartial(s, snap);
  const rejected = new Set<string>();
  for (const x of part.segs) {
    if (x.kind !== 'miss') continue;
    for (const r of snap.rejectedKor) if (x.kor.includes(r)) rejected.add(r);
  }
  const pending = [
    ...new Set(
      part.segs.flatMap((x) => (x.kind === 'term' && x.status === 'PENDING' ? [x.kor] : [])),
    ),
  ];
  return { pending, rejected: [...rejected], resegmented: null };
}
