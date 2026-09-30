import { describe, expect, it } from 'vitest';
import {
  joinPhysical,
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
