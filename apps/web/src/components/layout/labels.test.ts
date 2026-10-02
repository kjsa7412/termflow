import { describe, expect, it } from 'vitest';
import { historySummary } from './labels.js';

// CR-15 C14: 이력 줄이 "확정 · 확정(FINAL)", "복제 · 복제: …"처럼 동작을 되풀이하지 않게
describe('historySummary', () => {
  it('동작을 되풀이하는 앞부분을 뗀다(메모·원본은 남김)', () => {
    expect(historySummary('확정(FINAL)')).toBe('');
    expect(historySummary('확정(FINAL): 1차 검토 완료')).toBe('1차 검토 완료');
    expect(historySummary('확정 해제(DRAFT)')).toBe('');
    expect(historySummary('복제: QATEST/RP_RSCH_PRJ_PRTN_HST v2')).toBe(
      'QATEST/RP_RSCH_PRJ_PRTN_HST v2',
    );
  });
  it('다른 요약·빈 값은 그대로', () => {
    expect(historySummary('컬럼 +1 ~0 -0')).toBe('컬럼 +1 ~0 -0');
    expect(historySummary(null)).toBe('');
  });
});
