import { describe, expect, it } from 'vitest';
import {
  joinPhysical,
  pickAlternatives,
  segmentFull,
  segmentPartial,
  suffixOf,
  type Seg,
  type SegDict,
} from '../../src/autocomplete/segmenter.js';
import { makeSnapshot } from './autocomplete-fixtures.js';

// T9.2 분절 알고리즘(설계서 §5.3.1) — 합성 경계 케이스. 승계 649 논리명 스냅샷은 test/db/autocomplete-rms.test.ts
function dict(entries: Record<string, string | null>): SegDict {
  const m = new Map(Object.entries(entries).map(([k, v]) => [k, { physical: v }]));
  return { get: (k) => m.get(k), maxLen: Math.max(...[...m.keys()].map((k) => k.length)) };
}
const kors = (r: readonly Seg[]) =>
  r.map((x) => (x.kind === 'miss' ? `✗${x.kor}` : x.kor)).join('|');

describe('segmentFull — 최장일치 + 백트래킹, 조각 수 최소 우선', () => {
  const snap = makeSnapshot();

  it('설계서 예: 연구과제번호 → 연구|과제|번호 → RSCH_PRJ_NO, 접미어 NO', () => {
    const r = segmentFull('연구과제번호', snap);
    expect(r.map(kors)).toEqual(['연구|과제|번호']);
    expect(joinPhysical(r[0]!)).toBe('RSCH_PRJ_NO');
    expect(suffixOf(r[0]!)).toBe('NO');
  });

  it('조각 수 최소가 최장일치(탐욕)보다 우선(RK7): 가나다|라|마(3) 대신 가나|다라마(2)', () => {
    const d = dict({ 가나다: 'X', 라: 'R', 마: 'M', 가나: 'A', 다라마: 'B' });
    const r = segmentFull('가나다라마', d);
    expect(r.map(kors)).toEqual(['가나|다라마', '가나다|라|마']);
  });

  it('백트래킹: 첫 조각을 가장 길게 잡으면 막히는 경우 다음 길이로 되돌아간다(현행 L3 결함)', () => {
    const d = dict({ 가나다: 'X', 가나: 'A', 다라: 'B' });
    expect(segmentFull('가나다라', d).map(kors)).toEqual(['가나|다라']);
  });

  it('동수면 앞에서부터 조각 길이 내림차순 사전식: [2,2] > [1,3]', () => {
    const d = dict({ 가나: 'A', 다라: 'B', 가: 'C', 나다라: 'D' });
    expect(segmentFull('가나다라', d).map(kors)).toEqual(['가나|다라', '가|나다라']);
  });

  it('후보는 최대 3개', () => {
    const d = dict({ 가: 'A', 가가: 'B', 가가가: 'C' });
    const r = segmentFull('가가가가', d);
    expect(r).toHaveLength(3);
    expect(r.map(kors)).toEqual(['가가가|가', '가가|가가', '가|가가가']);
  });

  it('숫자 0~10 특례: 사전 없이 조각이 되고 물리명에 붙는다(라벨칸코드1 → LABEL_KAN_CD1, 구분10 → TP10)', () => {
    expect(joinPhysical(segmentFull('라벨칸코드1', snap)[0]!)).toBe('LABEL_KAN_CD1');
    const r = segmentFull('구분10', snap)[0]!;
    expect(r.map((x) => x.kind)).toEqual(['term', 'num']);
    expect(joinPhysical(r)).toBe('TP10');
    expect(suffixOf(r)).toBe('TP');
    // 11은 숫자 조각이 아니다(1|1로 쪼개진다)
    expect(segmentFull('구분11', snap)[0]!.map((x) => x.kor)).toEqual(['구분', '1', '1']);
  });

  it('physical 없는 용어(무효)·반려 용어(책임자)는 조각이 되지 않는다', () => {
    expect(segmentFull('무효번호', snap)).toEqual([]);
    expect(segmentFull('연구책임자구분', snap)).toEqual([]);
  });

  it('라틴 대문자 용어 ID', () => {
    expect(joinPhysical(segmentFull('연구과제ID', snap)[0]!)).toBe('RSCH_PRJ_ID');
  });

  it('긴 입력도 폭발하지 않는다: 60자(분절 수 피보나치) · 실패하는 40자', () => {
    const d = dict({ 가: 'A', 가가: 'B' });
    const t0 = performance.now();
    const r = segmentFull('가'.repeat(60), d);
    const fail = segmentFull(`${'가'.repeat(40)}쀍`, d);
    const ms = performance.now() - t0;
    expect(r).toHaveLength(3);
    expect(r[0]!).toHaveLength(30);
    expect(fail).toEqual([]);
    expect(ms).toBeLessThan(200);
  });

  it('빈 입력', () => {
    expect(segmentFull('', snap)).toEqual([]);
  });
});

describe('pickAlternatives — 편집기 대안 표시 기준(CR-10 C3)', () => {
  it('대표와 조각 수가 같은 후보만, 최대 max', () => {
    const d = dict({ 가: 'A', 가가: 'B', 가가가: 'C' });
    // 후보: 가가가|가, 가가|가가, 가|가가가 — 모두 2조각
    const full = segmentFull('가가가가', d);
    expect(pickAlternatives(full, 2).map(kors)).toEqual(['가가|가가', '가|가가가']);
    expect(pickAlternatives(full, 1).map(kors)).toEqual(['가가|가가']);
  });

  it('대표보다 조각이 많은 쪼갬은 뺀다: 검증|구분 대표 → 검증|구|분(OLD_MI) 제외', () => {
    const d = dict({ 검증: 'VRFC', 구분: 'TP', 구: 'OLD', 분: 'MI' });
    const full = segmentFull('검증구분', d);
    expect(full.map(kors)).toEqual(['검증|구분', '검증|구|분']);
    expect(pickAlternatives(full, 2)).toEqual([]);
  });

  it('1글자 조각이 절반을 넘는 후보는 뺀다, 절반 이하는 남긴다(총|사업비)', () => {
    const d = dict({ 총사: 'A', 업비: 'B', 총: 'TOT', 사업비: 'BIZ_EXP' });
    const full = segmentFull('총사업비', d);
    expect(full.map(kors)).toEqual(['총사|업비', '총|사업비']);
    expect(pickAlternatives(full, 2).map(kors)).toEqual(['총|사업비']);
    const d2 = dict({ 가나다: 'X', 가: 'A', 나: 'B', 다: 'C', 나다: 'D', 가나: 'E' });
    // 가나다(1조각) 대표 → 다른 1조각 없음. 3글자를 2조각으로: 가|나다, 가나|다 = 대표보다 많음 → 없음
    expect(pickAlternatives(segmentFull('가나다', d2), 2)).toEqual([]);
    const d3 = dict({ 가: 'A', 나: 'B', 다라: 'C', 가나: 'D', 라: 'E', 다: 'F' });
    // 가나|다라(대표, 1글자 0) · 가|나|다라는 3조각 → 제외 · 가나|다|라도 3조각 → 제외
    expect(pickAlternatives(segmentFull('가나다라', d3), 2)).toEqual([]);
  });

  it('물리명이 대표와 같으면 뺀다', () => {
    const d = dict({ 가나: 'X_Y', 가: 'X', 나: 'Y', 다라: 'Z', 나다라: 'Q', 다: 'P', 라: 'R' });
    const full = segmentFull('가나다라', d);
    // 대표 가나|다라 = X_Y_Z, 가|나다라 = X_Q(다름 → 남음)
    expect(full.map(kors).slice(0, 2)).toEqual(['가나|다라', '가|나다라']);
    const alts = pickAlternatives(full, 2);
    expect(alts.map(joinPhysical)).toEqual(['X_Q']);
    const same = dict({ 가나: 'X_Y', 가: 'X', 나다라: 'Y_Z', 다라: 'Z' });
    // 가나|다라 = X_Y_Z, 가|나다라 = X_Y_Z → 같은 물리명 제외
    expect(pickAlternatives(segmentFull('가나다라', same), 2)).toEqual([]);
  });
});

describe('segmentPartial — 미매칭 최소(DP)', () => {
  const snap = makeSnapshot();

  it('설계서 예: 연구책임자구분(책임자 미등록) → [연구 RSCH][책임자 ✗][구분 TP] → RSCH_?_TP', () => {
    const r = segmentPartial('연구책임자구분', snap);
    expect(kors(r.segs)).toBe('연구|✗책임자|구분');
    expect(r.unmatched).toBe(3);
    expect(joinPhysical(r.segs)).toBe('RSCH_?_TP');
    expect(suffixOf(r.segs)).toBe('TP');
  });

  it('연속 미매칭 글자는 한 조각, 끝이 미매칭이면 접미어 null', () => {
    const r = segmentPartial('연구쀍쀍', snap);
    expect(kors(r.segs)).toBe('연구|✗쀍쀍');
    expect(suffixOf(r.segs)).toBeNull();
    expect(joinPhysical(r.segs)).toBe('RSCH_?');
  });

  it('미매칭 수가 같으면 조각 수가 적은 쪽', () => {
    const d = dict({ 가나: 'A', 가: 'B', 나: 'C' });
    expect(kors(segmentPartial('가나쀍', d).segs)).toBe('가나|✗쀍');
  });

  it('전부 미매칭', () => {
    const r = segmentPartial('쀍쀍', snap);
    expect(kors(r.segs)).toBe('✗쀍쀍');
    expect(joinPhysical(r.segs)).toBe('?');
  });
});
