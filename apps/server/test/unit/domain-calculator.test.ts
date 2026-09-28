import { describe, expect, it } from 'vitest';
import {
  calculateDomain,
  isNumPart,
  normalizeParts,
  type DomainClsEntry,
  type L1Snapshot,
  type TermEntry,
} from '../../src/autocomplete/domain-calculator.js';

// T3.5 L1 DomainCalculator(설계서 §5.2, 10단계) — 순수 함수 단위 테스트
const terms: [string, string | null][] = [
  ['연구', 'RSCH'],
  ['과제', 'PRJ'],
  ['번호', 'NO'],
  ['라벨', 'LABEL'],
  ['칸', 'KAN'],
  ['코드', 'CD'],
  ['구분', 'TP'],
  ['명', 'NM'],
  ['ID', 'ID'],
  ['일시', 'DTS'],
  ['금액', 'AMT'],
  ['비율', 'RTE'],
  ['정보', 'INFO'],
  ['1차', null],
  ['13', '13'],
];
const cls: [string, DomainClsEntry][] = [
  ['NO', { domainClsId: 1, colType: 'VARCHAR', colLength: 20, colScale: null }],
  ['CD', { domainClsId: 2, colType: 'VARCHAR', colLength: 10, colScale: null }],
  ['TP', { domainClsId: 3, colType: 'VARCHAR', colLength: 10, colScale: null }],
  ['NM', { domainClsId: 4, colType: 'VARCHAR', colLength: 30, colScale: null }],
  ['AMT', { domainClsId: 5, colType: 'BIGINT', colLength: null, colScale: null }],
  ['RTE', { domainClsId: 6, colType: 'NUMERIC', colLength: 7, colScale: 4 }],
  ['DTS', { domainClsId: 7, colType: 'TIMESTAMP', colLength: 0, colScale: null }],
  ['ID', { domainClsId: 8, colType: 'VARCHAR', colLength: 20, colScale: null }],
];
const existing = new Set(['연구과제명']);
const snap: L1Snapshot = {
  termByKor: new Map<string, TermEntry>(terms.map(([k, p]) => [k, { physical: p }])),
  clsBySuffix: new Map(cls),
  logicalExists: (l) => existing.has(l),
};
const calc = (...parts: (string | null)[]) => calculateDomain({ parts }, snap);
const codes = (r: ReturnType<typeof calc>) => r.issues.map((i) => i.code);

describe('L1 — 설계서 §5.2 예시', () => {
  it('[연구, 과제, 번호] → RSCH_PRJ_NO, suffix NO, VARCHAR(20)', () => {
    const r = calc('연구', '과제', '번호');
    expect(r).toMatchObject({
      logicalNm: '연구과제번호',
      physicalNm: 'RSCH_PRJ_NO',
      descr: '연구_과제_번호',
      suffix: 'NO',
      domainClsId: 1,
      colType: 'VARCHAR',
      colLength: 20,
      colScale: null,
      typeText: 'VARCHAR(20)',
      notFound: [],
    });
    expect(r.issues).toEqual([]);
  });
  it('[라벨, 칸, 코드, 1] → LABEL_KAN_CD1(숫자는 _ 없이), descr 라벨_칸_코드1', () => {
    const r = calc('라벨', '칸', '코드', '1');
    expect(r.physicalNm).toBe('LABEL_KAN_CD1');
    expect(r.descr).toBe('라벨_칸_코드1');
    expect(r.logicalNm).toBe('라벨칸코드1');
    expect(r.suffix).toBe('CD');
    expect(r.typeText).toBe('VARCHAR(10)');
  });
  it('미등록 조각 → fallback upper(part)가 한글로 남고 notFound·W_TERM_UNREGISTERED', () => {
    const r = calc('건', '마찰', '정보');
    expect(r.notFound).toEqual(['건', '마찰']);
    expect(r.physicalNm).toBe('건_마찰_INFO');
    expect(codes(r)).toContain('W_TERM_UNREGISTERED');
    // 접미어 INFO는 이 스냅샷에 미등록 → 타입 NULL + W_SUFFIX_UNREGISTERED
    expect(r.colType).toBeNull();
    expect(codes(r)).toContain('W_SUFFIX_UNREGISTERED');
  });
});

describe('L1 — 1단계 조각 정리', () => {
  it('빈 값·NULL 건너뜀, 순서 유지, trim', () => {
    expect(normalizeParts([' 연구 ', null, '', '과제', undefined, '번호'])).toEqual([
      '연구',
      '과제',
      '번호',
    ]);
  });
  it("라틴 문자 대문자 정규화: 'id' → 'ID'(용어 조회 성공)", () => {
    const r = calc('연구', 'id');
    expect(r.parts).toEqual(['연구', 'ID']);
    expect(r.physicalNm).toBe('RSCH_ID');
    expect(r.notFound).toEqual([]);
  });
  it('조각이 모두 비면 E_DOMAIN_PARTS_EMPTY', () => {
    const r = calc(null, ' ', '');
    expect(r.logicalNm).toBe('');
    expect(codes(r)).toContain('E_DOMAIN_PARTS_EMPTY');
  });
});

describe('L1 — 2·3단계 숫자·용어', () => {
  it.each(['0', '1', '9', '10'])('isNum(%s) = true', (p) => expect(isNumPart(p)).toBe(true));
  it.each(['11', '1.0', '01', '-1', 'A', ''])('isNum(%s) = false', (p) =>
    expect(isNumPart(p)).toBe(false),
  );
  it('숫자 조각은 사전 조회 없이 확정(용어 미등록이어도 notFound 아님)', () => {
    const r = calc('코드', '7');
    expect(r.notFound).toEqual([]);
    expect(r.physicalNm).toBe('CD7');
  });
  it("'1.0' 소수 표기는 숫자가 아님(R1 정규화가 전제) → 미등록", () => {
    const r = calc('코드', '1.0');
    expect(r.notFound).toEqual(['1.0']);
    expect(r.physicalNm).toBe('CD_1.0');
  });
  it('11 이상은 숫자가 아니라 용어로 조회(용어 13 등록) → _ 붙음', () => {
    const r = calc('라벨', '코드', '13');
    expect(r.physicalNm).toBe('LABEL_CD_13');
    expect(r.suffix).toBe('13');
  });
  it('physical이 NULL인 용어는 미등록과 같게 본다', () => {
    const r = calc('1차', '금액');
    expect(r.notFound).toEqual(['1차']);
    expect(r.suffix).toBe('AMT');
  });
  it('첫 조각이 숫자여도 그대로 둔다', () => {
    expect(calc('1', '코드').physicalNm).toBe('1_CD');
  });
});

describe('L1 — 7단계 접미어', () => {
  it('마지막 비숫자 조각의 phys', () => {
    expect(calc('라벨', '코드', '1', '2').suffix).toBe('CD');
  });
  it('전부 숫자면 suffix NULL + W_SUFFIX_UNREGISTERED(접미어 없음)', () => {
    const r = calc('1', '2');
    expect(r.suffix).toBeNull();
    expect(r.physicalNm).toBe('12');
    expect(r.issues.find((i) => i.code === 'W_SUFFIX_UNREGISTERED')?.message).toContain(
      '접미어 없음',
    );
  });
  it('미등록 조각이 마지막이면 suffix는 upper(part)', () => {
    expect(calc('연구', '책임자').suffix).toBe('책임자');
  });
});

describe('L1 — 8·9단계 타입', () => {
  it('BIGINT: 길이 없음, typeText BIGINT', () => {
    expect(calc('과제', '금액')).toMatchObject({
      colType: 'BIGINT',
      colLength: null,
      typeText: 'BIGINT',
    });
  });
  it('NUMERIC(7,4)', () => {
    expect(calc('과제', '비율')).toMatchObject({
      colType: 'NUMERIC',
      colLength: 7,
      colScale: 4,
      typeText: 'NUMERIC(7,4)',
    });
  });
  it('TIMESTAMP(0)', () => {
    expect(calc('과제', '일시').typeText).toBe('TIMESTAMP(0)');
  });
  it('MANUAL이면 타입 계산을 생략(8~9단계), 물리명은 계산', () => {
    const r = calculateDomain({ parts: ['연구', '과제', '번호'], typeSource: 'MANUAL' }, snap);
    expect(r.colType).toBeNull();
    expect(r.domainClsId).toBeNull();
    expect(r.physicalNm).toBe('RSCH_PRJ_NO');
    expect(codes(r)).not.toContain('W_SUFFIX_UNREGISTERED');
  });
  it('저장용 값은 3분할이고 문자열 결합(VARCHAR(5.0))이 생기지 않는다', () => {
    const r = calc('연구', '번호');
    expect(typeof r.colLength).toBe('number');
    expect(r.typeText).not.toMatch(/\.0\)/);
  });
});

describe('L1 — 10단계 검증', () => {
  it('logical_nm 중복이면 E_DOMAIN_LOGICAL_DUP', () => {
    expect(codes(calc('연구', '과제', '명'))).toContain('E_DOMAIN_LOGICAL_DUP');
  });
  it('logicalExists 없으면 유니크 검사 생략', () => {
    const r = calculateDomain(
      { parts: ['연구', '과제', '명'] },
      { ...snap, logicalExists: undefined },
    );
    expect(codes(r)).not.toContain('E_DOMAIN_LOGICAL_DUP');
  });
  it('물리명 63자 초과 W_PHYS_LEN', () => {
    const ok = calculateDomain({ parts: ['연구', '과제', '금액'] }, snap);
    expect(codes(ok)).not.toContain('W_PHYS_LEN');
    const long = calculateDomain({ parts: ['연구', 'x'.repeat(70)] }, snap);
    expect(long.physicalNm.length).toBeGreaterThan(63);
    expect(codes(long)).toContain('W_PHYS_LEN');
  });
  it('입력 스냅샷을 바꾸지 않는다(순수 함수)', () => {
    const before = [...snap.termByKor.keys()].length;
    calc('새', '조각');
    expect([...snap.termByKor.keys()].length).toBe(before);
  });
});
