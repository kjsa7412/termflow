import { describe, expect, it } from 'vitest';
import type { L1Snapshot } from '../../src/autocomplete/domain-calculator.js';
import { planDomain, recalcDomain, type StoredDomain } from '../../src/standard/domain-plan.js';

// 도메인 저장 계획·재계산 규칙(T6.4, CR-05 C4) — 순수 함수
const snap: L1Snapshot = {
  termByKor: new Map([
    ['연구', { physical: 'RSCH' }],
    ['과제', { physical: 'PRJ' }],
    ['번호', { physical: 'NO' }],
    ['라벨', { physical: 'LABEL' }],
    ['칸', { physical: 'KAN' }],
    ['코드', { physical: 'CD' }],
    ['비고', { physical: 'RMK' }],
  ]),
  clsBySuffix: new Map([
    ['NO', { domainClsId: 1, colType: 'VARCHAR', colLength: 20, colScale: null }],
    ['CD', { domainClsId: 2, colType: 'VARCHAR', colLength: 10, colScale: null }],
  ]),
};
const auto = (...nm: (string | null)[]) =>
  planDomain({ nm, typeSource: 'AUTO', colType: null, colLength: null, colScale: null }, snap);

describe('planDomain', () => {
  it('정상: 물리명·접미어·타입·분류 연결, 검토 아님', () => {
    const p = auto('연구', '과제', '번호');
    expect(p).toMatchObject({
      logicalNm: '연구과제번호',
      physicalNm: 'RSCH_PRJ_NO',
      suffix: 'NO',
      domainClsId: 1,
      colType: 'VARCHAR',
      colLength: 20,
      typeText: 'VARCHAR(20)',
      reviewYn: false,
      errors: [],
    });
    expect(p.nm).toEqual(['연구', '과제', '번호', null, null, null, null]);
  });
  it('숫자 조각: _ 없이 붙고 접미어는 마지막 비숫자 조각', () => {
    expect(auto('라벨', '칸', '코드', '1')).toMatchObject({
      physicalNm: 'LABEL_KAN_CD1',
      suffix: 'CD',
    });
  });
  it('미등록 조각: 물리명 NULL + 검토(R15), 접미어 조각이 등록돼 있으면 타입은 채운다', () => {
    const p = auto('연구', '마찰', '번호');
    expect(p).toMatchObject({ physicalNm: null, colType: 'VARCHAR', reviewYn: true });
    expect(p.assembledPhysical).toBe('RSCH_마찰_NO');
    expect(p.reviewReasons).toEqual(['미등록 조각: 마찰']);
    expect(p.warnings.map((w) => w.code)).toEqual(['W_TERM_UNREGISTERED']);
  });
  it('접미어 분류 없음: 타입 NULL + 검토 W_SUFFIX_UNREGISTERED', () => {
    const p = auto('연구', '비고');
    expect(p).toMatchObject({
      physicalNm: 'RSCH_RMK',
      suffix: 'RMK',
      colType: null,
      reviewYn: true,
    });
    expect(p.reviewReasons).toEqual(['접미어 RMK 미등록']);
  });
  it('MANUAL: 타입 필수(E_TYPE_MISSING)·길이 규칙(E_TYPE_LEN_*), 분류 연결은 유지', () => {
    expect(
      planDomain(
        {
          nm: ['연구', '번호'],
          typeSource: 'MANUAL',
          colType: null,
          colLength: null,
          colScale: null,
        },
        snap,
      ).errors[0]!.code,
    ).toBe('E_TYPE_MISSING');
    expect(
      planDomain(
        {
          nm: ['연구', '번호'],
          typeSource: 'MANUAL',
          colType: 'VARCHAR',
          colLength: null,
          colScale: null,
        },
        snap,
      ).errors[0]!.code,
    ).toBe('E_TYPE_LEN_MISSING');
    const ok = planDomain(
      {
        nm: ['연구', '번호'],
        typeSource: 'MANUAL',
        colType: 'NUMERIC',
        colLength: 10,
        colScale: 2,
      },
      snap,
    );
    expect(ok).toMatchObject({
      typeText: 'NUMERIC(10,2)',
      domainClsId: 1,
      reviewYn: false,
      errors: [],
    });
  });
  it('명칭 1 필수, 물리명 63자 초과는 NULL + 검토', () => {
    expect(auto(null, '번호').errors[0]!.code).toBe('E_DOMAIN_PARTS_EMPTY');
    const long = planDomain(
      {
        nm: ['연구', '과제', '번호', '연구', '과제', '번호', '연구'.repeat(1)],
        typeSource: 'AUTO',
        colType: null,
        colLength: null,
        colScale: null,
      },
      { ...snap, termByKor: new Map([...snap.termByKor, ['연구', { physical: 'R'.repeat(20) }]]) },
    );
    expect(long.physicalNm).toBeNull();
    expect(long.reviewReasons[0]).toMatch(/물리명 형식·길이 위반/);
  });
});

const stored = (over: Partial<StoredDomain>): StoredDomain => ({
  domainId: 1,
  nm: ['연구', '마찰', '번호', null, null, null, null],
  logicalNm: '연구마찰번호',
  physicalNm: null,
  descr: 'not found',
  suffix: null,
  domainClsId: null,
  colType: null,
  colLength: null,
  colScale: null,
  typeSource: 'AUTO',
  reviewYn: true,
  reviewNote: '미등록 조각: 마찰; 접미어 없음',
  ...over,
});

describe('recalcDomain', () => {
  it('정정 전: 검토 유지, 문구만 다른 변경은 하지 않는다(타입은 채울 수 있으면 채운다)', () => {
    const r = recalcDomain(
      stored({ colType: 'VARCHAR', colLength: 20, suffix: 'NO', domainClsId: 1 }),
      snap,
    );
    expect(r.changes).toEqual({});
  });
  it('용어 등록 후: 물리명·설명 채움 + 검토 해제', () => {
    const s2: L1Snapshot = {
      ...snap,
      termByKor: new Map([...snap.termByKor, ['마찰', { physical: 'FRIC' }]]),
    };
    const r = recalcDomain(stored({}), s2);
    expect(r.next).toMatchObject({
      physicalNm: 'RSCH_FRIC_NO',
      descr: '연구_마찰_번호',
      suffix: 'NO',
      domainClsId: 1,
      colType: 'VARCHAR',
      reviewYn: false,
      reviewNote: null,
    });
  });
  it('기존 물리명은 유지(승계 원본 보존), C3 표시 행만 L1 결과로 교체', () => {
    const keep = recalcDomain(
      stored({
        nm: ['연구', '번호'],
        logicalNm: '연구번호',
        physicalNm: 'RSCH_NUM',
        reviewNote: '접미어 없음',
      }),
      snap,
    );
    expect(keep.next.physicalNm).toBe('RSCH_NUM');
    expect(keep.next.reviewYn).toBe(false);
    const c3 = recalcDomain(
      stored({
        nm: ['연구', '번호'],
        logicalNm: '연구번호',
        physicalNm: 'RSCH_NUM',
        reviewNote: 'C3: 복사 후 L1 불일치(물리명)',
      }),
      snap,
    );
    expect(c3.changes['physicalNm']).toEqual(['RSCH_NUM', 'RSCH_NO']);
  });
  it('조각 연결 ≠ 논리명: 계산 결과를 쓰지 않는다(검토 행은 검토 유지, 검토가 아닌 행은 그대로)', () => {
    const rev = recalcDomain(stored({ nm: ['연구', '번호'], logicalNm: '검토' }), snap);
    expect(rev.next.reviewYn).toBe(true);
    expect(rev.changes).toEqual({}); // 검토 유지 + 사유 문구만 다르면 갱신하지 않는다
    const non = recalcDomain(
      stored({
        nm: ['연구', '번호'],
        logicalNm: '검토',
        physicalNm: 'RVIEW',
        reviewYn: false,
        reviewNote: null,
      }),
      snap,
    );
    expect(non.changes).toEqual({});
  });
  it('MANUAL 타입 유지, 사람이 고칠 사유(수기 타입 해석 불가)는 남긴다', () => {
    const r = recalcDomain(
      stored({
        nm: ['연구', '번호'],
        logicalNm: '연구번호',
        physicalNm: 'RSCH_NO',
        typeSource: 'MANUAL',
        colType: 'TEXT',
        reviewNote: '수기 타입 해석 불가: VARHCAR(3)',
      }),
      snap,
    );
    expect(r.next.colType).toBe('TEXT');
    expect(r.next.reviewYn).toBe(true);
    expect(r.next.reviewNote).toBe('수기 타입 해석 불가: VARHCAR(3)');
  });
  it('AUTO: 분류 타입이 바뀌면 반영, 분류를 못 찾으면 저장 타입을 지우지 않는다', () => {
    const s2: L1Snapshot = {
      ...snap,
      clsBySuffix: new Map([
        ['NO', { domainClsId: 1, colType: 'VARCHAR', colLength: 30, colScale: null }],
      ]),
    };
    const base = {
      nm: ['연구', '번호'],
      logicalNm: '연구번호',
      physicalNm: 'RSCH_NO',
      suffix: 'NO',
      domainClsId: 1,
      colType: 'VARCHAR' as const,
      colLength: 20,
      reviewYn: false,
      reviewNote: null,
    };
    expect(recalcDomain(stored(base), s2).changes).toEqual({ colLength: [20, 30] });
    const noCls: L1Snapshot = { ...snap, clsBySuffix: new Map() };
    const r = recalcDomain(stored(base), noCls);
    expect(r.next.colType).toBe('VARCHAR');
    expect(r.next.reviewYn).toBe(false);
  });
});
