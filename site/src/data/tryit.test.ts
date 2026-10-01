import { describe, expect, it } from 'vitest';
import { EXAMPLES, resolve, segment } from './tryit.js';

describe('직접 해 보기(축약 엔진)', () => {
  it('가장 긴 용어부터 자르고, 모르는 글자는 미등록 조각 하나로', () => {
    expect(segment('교육과정번호').map((p) => p.kor)).toEqual(['교육', '과정', '번호']);
    expect(segment('강의실번호')).toEqual([
      { kor: '강의실', physical: null },
      { kor: '번호', physical: 'NO' },
    ]);
  });

  it('판정 다섯 갈래 — 예시마다 하나씩', () => {
    const v = EXAMPLES.map((e) => resolve(e).verdict);
    expect(v).toEqual(['exact', 'composed', 'similar', 'code', 'unregistered']);
  });

  it('표준·조합은 물리명과 타입, 코드는 코드값, 비슷한 후보는 목록', () => {
    expect(resolve('교육과정번호')).toMatchObject({ physical: 'EDU_CRS_NO', type: 'VARCHAR(20)' });
    expect(resolve('교육신청일자')).toMatchObject({ physical: 'EDU_REQ_DT', type: 'VARCHAR(8)' });
    expect(resolve('교육구분코드').code?.codes).toContain('02 온라인');
    expect(resolve('신청일').candidates.map((c) => c.logical)).toContain('신청일자');
    expect(resolve('강의실번호')).toMatchObject({ physical: '?_NO' });
    expect(resolve('  ').verdict).toBe('empty');
  });
});
