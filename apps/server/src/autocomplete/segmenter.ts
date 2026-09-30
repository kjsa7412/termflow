import type { TermStatus } from '@termflow/shared';
import { isNumPart } from './domain-calculator.js';

/**
 * 논리명 분절(설계서 §5.3.1, RK7·L3 개선, T9.2). **순수 함수** — 사전 인터페이스(`SegDict`)에만 의존한다.
 *  - `segmentFull`: 완전 분절 후보(최장일치 + 백트래킹, 조각 수 최소 우선, 상위 3).
 *  - `segmentPartial`: 완전 분절이 없을 때 미매칭 글자 수 최소 분절(DP, 비교 순서 unmatched → 조각 수).
 * 숫자 0~10은 사전과 무관하게 조각이 된다(L1 2단계와 같은 `isNumPart`).
 *
 * 설계서 의사코드는 "완전 분절을 모두 나열(상한 200) 후 정렬"이지만, 뒤에서부터의 최소 조각 수(`minSegs`)로 가지치기해
 * 같은 결과(정렬 기준 상위 3)를 나열 없이 얻는다: DFS가 긴 조각부터 시도하므로 **찾는 순서 = "앞에서부터 조각 길이
 * 내림차순 사전식" 순서**이고, 이미 상위 3이 찼으면 조각 수가 3위 이상인 가지는 더 볼 필요가 없다(CR-08 C2).
 * 도달 불가 위치(`minSegs = ∞`)는 들어가지 않으므로 실패 가지 폭발도 없다.
 */

/** 사전 1행(자동완성 대상 용어: APPROVED·PENDING이고 physical 있음, §4.5). */
export interface SegTerm {
  readonly physical: string | null;
  readonly termId?: number;
  readonly status?: TermStatus;
}

export interface SegDict {
  get(kor: string): SegTerm | undefined;
  /** 가장 긴 한글 용어 길이(조각 시도 상한). */
  readonly maxLen: number;
}

export type Seg =
  | {
      readonly kind: 'term';
      readonly kor: string;
      readonly physical: string;
      readonly termId?: number;
      readonly status?: TermStatus;
    }
  | { readonly kind: 'num'; readonly kor: string; readonly physical: string }
  | { readonly kind: 'miss'; readonly kor: string };

export const FULL_CANDIDATES_MAX = 3;
/** 탐색 노드 상한(안전장치 — 가지치기로 실측은 입력 길이 × 수십 이하). */
const NODE_CAP = 50_000;
const INF = Number.MAX_SAFE_INTEGER;

/**
 * 사전 조각 1개. 숫자 0~10은 **사전보다 먼저** 숫자 조각으로 확정한다(L1 3단계 "숫자는 사전 조회 없이 확정" — 승계 R1이
 * '1' 같은 숫자 용어를 등록해 두었어도 물리명은 L1과 같이 앞 조각에 붙는다, CR-08 C2). physical 없는 용어는 미등록.
 */
function pieceSeg(dict: SegDict, piece: string): Seg | null {
  if (isNumPart(piece)) return { kind: 'num', kor: piece, physical: piece };
  const t = dict.get(piece);
  if (t && t.physical) {
    return {
      kind: 'term',
      kor: piece,
      physical: t.physical,
      ...(t.termId !== undefined ? { termId: t.termId } : {}),
      ...(t.status !== undefined ? { status: t.status } : {}),
    };
  }
  return null;
}

/** 위치별 매칭 조각(긴 것부터). 숫자 '10'이 2글자이므로 상한은 최소 2. */
function matchTable(s: string, dict: SegDict): { len: number; seg: Seg }[][] {
  const maxLen = Math.max(dict.maxLen, 2);
  const out: { len: number; seg: Seg }[][] = [];
  for (let pos = 0; pos < s.length; pos++) {
    const list: { len: number; seg: Seg }[] = [];
    for (let L = Math.min(maxLen, s.length - pos); L >= 1; L--) {
      const seg = pieceSeg(dict, s.slice(pos, pos + L));
      if (seg) list.push({ len: L, seg });
    }
    out.push(list);
  }
  return out;
}

const numCount = (r: readonly Seg[]) => r.filter((x) => x.kind === 'num').length;

/** 정렬 기준(§5.3.1): 조각 수 asc → 앞에서부터 조각 길이 내림차순 사전식 → 숫자 조각 수 asc. */
export function compareSegmentations(a: readonly Seg[], b: readonly Seg[]): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) {
    const d = b[i]!.kor.length - a[i]!.kor.length;
    if (d !== 0) return d;
  }
  return numCount(a) - numCount(b);
}

/** 완전 분절 후보(조각 수 최소·최장일치 순, 최대 `limit`). 없으면 빈 배열. */
export function segmentFull(s: string, dict: SegDict, limit = FULL_CANDIDATES_MAX): Seg[][] {
  const n = s.length;
  if (n === 0) return [];
  const matches = matchTable(s, dict);
  const minSegs = new Array<number>(n + 1).fill(INF);
  minSegs[n] = 0;
  for (let pos = n - 1; pos >= 0; pos--) {
    for (const m of matches[pos]!) {
      const rest = minSegs[pos + m.len]!;
      if (rest !== INF && rest + 1 < minSegs[pos]!) minSegs[pos] = rest + 1;
    }
  }
  if (minSegs[0] === INF) return [];

  const best: Seg[][] = [];
  const acc: Seg[] = [];
  let nodes = 0;
  const walk = (pos: number): void => {
    if (++nodes > NODE_CAP) return;
    if (pos === n) {
      best.push([...acc]);
      best.sort(compareSegmentations);
      if (best.length > limit) best.length = limit;
      return;
    }
    if (minSegs[pos] === INF) return;
    // 이후에 찾는 결과는 앞선 결과보다 사전식으로 뒤다 → 조각 수가 현재 limit위 이상이면 가지치기
    if (best.length === limit && acc.length + minSegs[pos]! >= best[limit - 1]!.length) return;
    for (const m of matches[pos]!) {
      if (minSegs[pos + m.len] === INF) continue;
      acc.push(m.seg);
      walk(pos + m.len);
      acc.pop();
    }
  };
  walk(0);
  return best;
}

interface Cell {
  unmatched: number;
  segs: number;
  lastMiss: boolean;
  from: number;
  seg: Seg | null; // null = 미매칭 1글자 확장
}

const better = (a: { unmatched: number; segs: number }, b: Cell | null) =>
  b === null || a.unmatched < b.unmatched || (a.unmatched === b.unmatched && a.segs < b.segs);

/**
 * 미매칭 최소 분절(§5.3.1 segmentPartial). 연속 미매칭 글자는 한 조각(`miss`)으로 합친다.
 * 동점이면 긴 매칭 조각 → 매칭 조각 → 미매칭 확장 순으로 먼저 찾은 것을 유지한다.
 */
export function segmentPartial(s: string, dict: SegDict): { segs: Seg[]; unmatched: number } {
  const n = s.length;
  if (n === 0) return { segs: [], unmatched: 0 };
  const maxLen = Math.max(dict.maxLen, 2);
  const best: (Cell | null)[] = new Array<Cell | null>(n + 1).fill(null);
  best[0] = { unmatched: 0, segs: 0, lastMiss: false, from: -1, seg: null };
  for (let i = 1; i <= n; i++) {
    let cur: Cell | null = null;
    for (let L = Math.min(maxLen, i); L >= 1; L--) {
      const prev = best[i - L];
      if (!prev) continue;
      const seg = pieceSeg(dict, s.slice(i - L, i));
      if (!seg) continue;
      const cand = { unmatched: prev.unmatched, segs: prev.segs + 1 };
      if (better(cand, cur)) cur = { ...cand, lastMiss: false, from: i - L, seg };
    }
    const p = best[i - 1]!;
    const miss = { unmatched: p.unmatched + 1, segs: p.segs + (p.lastMiss ? 0 : 1) };
    if (better(miss, cur)) cur = { ...miss, lastMiss: true, from: i - 1, seg: null };
    best[i] = cur;
  }
  // 역추적 → 연속 미매칭 병합
  const rev: Seg[] = [];
  let i = n;
  let missBuf = '';
  while (i > 0) {
    const c = best[i]!;
    if (c.seg === null) {
      missBuf = s[i - 1]! + missBuf;
    } else {
      if (missBuf !== '') {
        rev.push({ kind: 'miss', kor: missBuf });
        missBuf = '';
      }
      rev.push(c.seg);
    }
    i = c.from;
  }
  if (missBuf !== '') rev.push({ kind: 'miss', kor: missBuf });
  return { segs: rev.reverse(), unmatched: best[n]!.unmatched };
}

/**
 * 조각 → 물리명(L1 5단계: 첫 조각 그대로, 이후 숫자는 붙이고 나머지는 `_` 연결). 미매칭 조각은 `?`(저장 금지, §5.3 ⑤).
 */
export function joinPhysical(segs: readonly Seg[]): string {
  return segs
    .map((x, i) => {
      const p = x.kind === 'miss' ? '?' : x.physical;
      return i === 0 || x.kind === 'num' ? p : `_${p}`;
    })
    .join('');
}

/** L1 7단계 접미어: 마지막 비숫자 조각의 physical(미매칭이면 null). */
export function suffixOf(segs: readonly Seg[]): string | null {
  for (let i = segs.length - 1; i >= 0; i--) {
    const x = segs[i]!;
    if (x.kind === 'num') continue;
    return x.kind === 'term' ? x.physical : null;
  }
  return null;
}
