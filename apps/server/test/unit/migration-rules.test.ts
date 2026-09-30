import { describe, expect, it } from 'vitest';
import type { DomainClsEntry, L1Snapshot } from '../../src/autocomplete/domain-calculator.js';
import {
  isNumericDotZero,
  normalizeNumericText,
} from '../../src/migration/rules/r01-numeric-terms.js';
import { shouldNullDescription } from '../../src/migration/rules/r02-description.js';
import { convertDomainClsType } from '../../src/migration/rules/r03-domain-cls-length.js';
import { decideSynonymRef } from '../../src/migration/rules/r04-synonym.js';
import { decideDomain, type LegacyDomainRow } from '../../src/migration/rules/r05-r15-domain.js';
import { decideTermPhysical, synonymGroups } from '../../src/migration/rules/r08-physical.js';
import { normalizePhysicalName } from '../../src/migration/rules/r09-physical-name.js';
import { R12_EXCLUDED } from '../../src/migration/rules/r12-unused.js';
import { migratedTimes } from '../../src/migration/rules/r13-audit.js';
import { NEW_SUFFIXES } from '../../src/migration/rules/new-suffixes.js';
import {
  planRenames,
  r19ColumnName,
  r19TableName,
} from '../../src/migration/rules/r19-term-unify.js';

// T3.14 규칙별 단위 테스트. 입력은 dump(`seed/original/dump-gen_table-new.sql`)에서 발췌한 실제 행.

describe('R1 숫자 용어', () => {
  it("'13.0' → '13', 정수·문자는 그대로", () => {
    expect(normalizeNumericText('13.0')).toBe('13');
    expect(normalizeNumericText(' 1.0 ')).toBe('1');
    expect(normalizeNumericText('10')).toBe('10');
    expect(normalizeNumericText('1차')).toBe('1차');
    expect(normalizeNumericText('1.5')).toBe('1.5');
    expect(normalizeNumericText(null)).toBeNull();
    expect(isNumericDotZero('20.0')).toBe(true);
    expect(isNumericDotZero('20')).toBe(false);
  });
});

describe('R2 설명 정리', () => {
  it.each([
    ['R', '2차', true], // 1자 이하
    ['1', '조사', true],
    ['ㄱ', '10', true],
    ['BPM', 'BPM', true], // 용어와 동일
    ['   ', '가', true], // 공백
    ['Proposer', '제안자', false],
    [null, '가', false],
  ])('%s / %s → %s', (desc, kor, expected) => {
    expect(shouldNullDescription(desc, kor)).toBe(expected);
  });
});

describe('R3 도메인분류 길이', () => {
  it('정수 문자열·소수 표기 → 정수(field col_length)', () => {
    expect(convertDomainClsType('VARCHAR', '100')).toMatchObject({
      colType: 'VARCHAR',
      colLength: 100,
      colScale: null,
      review: false,
      change: { field: 'col_length', after: 'VARCHAR(100)' },
    });
    expect(convertDomainClsType('VARCHAR', '5.0')).toMatchObject({ colLength: 5 });
  });
  it("'6,2' → precision 6 / scale 2", () => {
    expect(convertDomainClsType('NUMERIC', '6,2')).toMatchObject({
      colType: 'NUMERIC',
      colLength: 6,
      colScale: 2,
      change: { after: 'NUMERIC(6,2)' },
    });
  });
  it('TIMESTAMP(0) → TIMESTAMP + length 0(field col_type)', () => {
    expect(convertDomainClsType('TIMESTAMP(0)', null)).toMatchObject({
      colType: 'TIMESTAMP',
      colLength: 0,
      change: { field: 'col_type' },
    });
  });
  it('길이 없는 정수 타입은 변환 없음', () => {
    expect(convertDomainClsType('BIGINT', null)).toMatchObject({
      colType: 'BIGINT',
      colLength: null,
      change: null,
    });
  });
  it('해석 불가 길이 → 길이 NULL + review, 모르는 타입은 실패', () => {
    expect(convertDomainClsType('VARCHAR', 'abc')).toMatchObject({
      colType: 'VARCHAR',
      colLength: null,
      review: true,
    });
    expect(() => convertDomainClsType('VARHCAR', '3')).toThrow(/R3/);
  });
});

describe('R4 동의어 참조', () => {
  it("숫자만('63') → NULL, 그 외 보존, 빈 값 없음", () => {
    expect(decideSynonymRef('63')).toEqual({ kind: 'NULLED', before: '63' });
    expect(decideSynonymRef('가, 가격')).toEqual({ kind: 'KEPT', value: '가, 가격' });
    expect(decideSynonymRef('')).toEqual({ kind: 'NONE' });
    expect(decideSynonymRef(null)).toEqual({ kind: 'NONE' });
  });
});

describe('R8 물리약어', () => {
  it("upper(trim): 'Mtrc' → MTRC(NORMALIZED), 이미 대문자는 KEEP", () => {
    expect(decideTermPhysical('Mtrc', '지표')).toEqual({ kind: 'NORMALIZED', value: 'MTRC' });
    expect(decideTermPhysical('RSCH', '연구')).toEqual({ kind: 'KEEP', value: 'RSCH' });
  });
  it("NULL·형식 위반: 숫자 용어는 term_kor로, 아니면 REVIEW('1차')", () => {
    expect(decideTermPhysical(null, '5')).toEqual({ kind: 'FILLED_NUMERIC', value: '5' });
    expect(decideTermPhysical(null, '1차')).toMatchObject({
      kind: 'REVIEW',
      note: '물리약어 없음',
    });
    expect(decideTermPhysical('가-격', '가격')).toMatchObject({ kind: 'REVIEW' });
  });
  it('동의어 그룹: 같은 physical 공유(NULL 제외)', () => {
    const g = synonymGroups([
      { termKor: '가', physical: 'PRICE' },
      { termKor: '가격', physical: 'PRICE' },
      { termKor: '가공', physical: 'PROC' },
      { termKor: '1차', physical: null },
      { termKor: '5.0', physical: null },
    ]);
    expect(g).toEqual([{ physical: 'PRICE', terms: ['가', '가격'] }]);
  });
});

describe('R9 물리명 정규화', () => {
  it("'Adpt_RSLT_CD' → 대문자, 형식·길이 판정", () => {
    expect(normalizePhysicalName('Adpt_RSLT_CD')).toMatchObject({
      value: 'ADPT_RSLT_CD',
      changed: true,
      formatError: false,
    });
    expect(normalizePhysicalName('A'.repeat(64))).toMatchObject({ tooLong: true });
    expect(normalizePhysicalName('A'.repeat(31))).toMatchObject({
      tooLong: false,
      oracleLong: true,
    });
    expect(normalizePhysicalName('가_CD')).toMatchObject({ formatError: true });
    expect(normalizePhysicalName(null)).toMatchObject({ value: null });
  });
});

describe('R12·R13', () => {
  it('R12 제외 목록에 원본 미사용 열·테이블이 있다', () => {
    expect(R12_EXCLUDED).toContain('tb_domain.bi_only_yn');
    expect(R12_EXCLUDED).toContain('tb_table_schema.session_id');
  });
  it('R13 일시는 원본 유지, 최종 일시가 없으면 최초 일시', () => {
    expect(migratedTimes('2026-03-17 15:27:01', '2026-03-18 10:00:00')).toEqual({
      createdAt: '2026-03-17 15:27:01',
      updatedAt: '2026-03-18 10:00:00',
    });
    expect(migratedTimes('2026-03-17 15:27:01', null)).toEqual({
      createdAt: '2026-03-17 15:27:01',
      updatedAt: '2026-03-17 15:27:01',
    });
    expect(migratedTimes(null, null)).toEqual({});
  });
});

describe('신규 접미어 30종(D12)', () => {
  it('30종, 중복 없음, 검토 표시 8종, 합계 289건 근거 접미어 포함', () => {
    expect(NEW_SUFFIXES).toHaveLength(30);
    expect(new Set(NEW_SUFFIXES.map((s) => s.suffix)).size).toBe(30);
    expect(
      NEW_SUFFIXES.filter((s) => s.review)
        .map((s) => s.suffix)
        .sort(),
    ).toEqual(['INFO', 'MSMT', 'PART', 'PRD', 'SHOP', 'SHP', 'STD', 'WGHT']);
    expect(NEW_SUFFIXES.find((s) => s.suffix === 'WKN')).toMatchObject({
      colType: 'SMALLINT',
      colLength: null,
    });
  });
});

// R5·R15(DOMAIN step 행 규칙) — 발췌 스냅샷
const cls = (
  colType: DomainClsEntry['colType'],
  colLength: number | null,
  colScale: number | null = null,
  id = 1,
): DomainClsEntry => ({ domainClsId: id, colType, colLength, colScale });
const snap: L1Snapshot = {
  termByKor: new Map(
    (
      [
        ['라벨', 'LABEL'],
        ['코드', 'CD'],
        ['정보', 'INFO'],
        ['기종', null],
        ['경로', 'PATH'],
        ['구분', 'TP'],
        ['매장', 'SHOP'],
        ['운영', 'OPRT'],
        ['기준', 'STD'],
        ['년', 'YY'],
        ['주차', 'WKN'],
        ['검토', 'RVIEW'],
        ['건', null],
        ['마찰', null],
        ['13', '13'],
        ['경도', 'LGTD'],
        ['값', 'VAL'],
        ['상태', 'STAT'],
      ] as [string, string | null][]
    ).map(([k, p]) => [k, { physical: p }]),
  ),
  clsBySuffix: new Map([
    ['CD', cls('VARCHAR', 10, null, 11)],
    ['PATH', cls('VARCHAR', 100, null, 12)],
    ['TP', cls('VARCHAR', 10, null, 13)],
    ['INFO', cls('VARCHAR', 200, null, 14)],
    ['WKN', cls('SMALLINT', null, null, 15)],
    ['VAL', cls('NUMERIC', 6, 2, 16)],
    ['STAT', cls('VARCHAR', 10, null, 17)],
  ]),
};
const row = (over: Partial<LegacyDomainRow>): LegacyDomainRow => ({
  domainId: 1,
  nm: [],
  logicalNm: '',
  physicalNm: null,
  descr: null,
  suffix: null,
  colType: null,
  colLength: null,
  colTypeManual: null,
  ...over,
});

describe('R5 타입 미정 도메인 + R5-b 수기 우선', () => {
  it('원본 타입 있음 → 3분할 AUTO, domain_cls 연결(경로 PATH)', () => {
    const d = decideDomain(
      row({
        nm: ['경로'],
        logicalNm: '경로',
        physicalNm: 'PATH',
        suffix: 'PATH',
        colType: 'VARCHAR',
        colLength: '100',
      }),
      snap,
    );
    expect(d.target).toMatchObject({
      colType: 'VARCHAR',
      colLength: 100,
      typeSource: 'AUTO',
      domainClsId: 12,
      reviewYn: false,
    });
    expect(d.r5).toBeNull();
  });
  it('R5-b: 원본 타입 + 다른 수기 타입 → MANUAL(경로 VARCHAR(200))', () => {
    const d = decideDomain(
      row({
        nm: ['경로'],
        logicalNm: '경로',
        physicalNm: 'PATH',
        suffix: 'PATH',
        colType: 'VARCHAR',
        colLength: '100',
        colTypeManual: 'VARCHAR(200)',
      }),
      snap,
    );
    expect(d.r5).toBe('MANUAL_OVERRIDE');
    expect(d.target).toMatchObject({ colType: 'VARCHAR', colLength: 200, typeSource: 'MANUAL' });
  });
  it('수기 타입 해석 불가(numeric(4,6)) → 접미어 타입 유지 + review', () => {
    const d = decideDomain(
      row({
        nm: ['경도', '값'],
        logicalNm: '경도값',
        physicalNm: 'LGTD_VAL',
        suffix: 'VAL',
        colType: 'NUMERIC',
        colLength: '6,2',
        colTypeManual: 'numeric(4,6)',
      }),
      snap,
    );
    expect(d.target).toMatchObject({
      colType: 'NUMERIC',
      colLength: 6,
      colScale: 2,
      typeSource: 'AUTO',
      reviewYn: true,
    });
    expect(d.target.reviewNote).toContain('수기 타입 해석 불가');
  });
  it('① 타입 NULL + 수기 유효(VARCHAR2(6) 별칭) → MANUAL', () => {
    const d = decideDomain(
      row({
        nm: ['기준', '년', '주차'],
        logicalNm: '기준년주차',
        physicalNm: 'STD_YY_WKN',
        suffix: 'WKN',
        colTypeManual: 'VARCHAR2(6)',
      }),
      snap,
    );
    expect(d.r5).toBe('MANUAL');
    expect(d.target).toMatchObject({
      colType: 'VARCHAR',
      colLength: 6,
      typeSource: 'MANUAL',
      reviewYn: false,
      domainClsId: 15,
    });
  });
  it('② 타입 NULL + 신규 접미어 → L1 재계산 RECALC', () => {
    const d = decideDomain(
      row({ nm: ['매장', '상태'], logicalNm: '매장상태', physicalNm: 'SHOP_STAT', suffix: 'STAT' }),
      snap,
    );
    expect(d.r5).toBe('RECALC');
    expect(d.target).toMatchObject({
      colType: 'VARCHAR',
      colLength: 10,
      typeSource: 'AUTO',
      suffix: 'STAT',
      domainClsId: 17,
      reviewYn: false,
    });
  });
  it("③ 접미어 미등록 → REVIEW, review_note '접미어 X 미등록'", () => {
    const d = decideDomain(
      row({ nm: ['매장', '운영'], logicalNm: '매장운영', physicalNm: 'SHOP_OPRT', suffix: 'OPRT' }),
      snap,
    );
    expect(d.r5).toBe('REVIEW');
    expect(d.target).toMatchObject({
      colType: null,
      reviewYn: true,
      reviewNote: '접미어 OPRT 미등록',
    });
  });
  it('③ 수기 타입 오타(VARHCAR(3))는 자동 수정하지 않고 review', () => {
    const d = decideDomain(
      row({
        nm: ['매장', '운영'],
        logicalNm: '매장운영',
        physicalNm: 'SHOP_OPRT',
        suffix: 'OPRT',
        colTypeManual: 'VARHCAR(3)',
      }),
      snap,
    );
    expect(d.target.reviewNote).toContain('수기 타입 해석 불가: VARHCAR(3)');
  });
  it('명칭 조각과 논리명이 다르면(원본 9167 검토) 재계산하지 않고 review', () => {
    const d = decideDomain(
      row({
        nm: ['검토', 'RVIEW', 'Review'],
        logicalNm: '검토',
        physicalNm: 'RVIEW',
        suffix: 'RVIEW',
        colType: '',
      }),
      snap,
    );
    expect(d.r5).toBe('REVIEW');
    expect(d.target.reviewNote).toContain('명칭 조각과 논리명 불일치');
  });
});

describe('R15 물리명 재생성 + R1 명칭 조각', () => {
  it("R1: nm '13.0' → '13'(r01 리포트), 미등록 조각이 있으면 physical NULL + review", () => {
    const d = decideDomain(
      row({
        nm: ['라벨', '칸코드', '13.0'],
        logicalNm: '라벨칸코드13',
        descr: 'not found',
        suffix: '13',
      }),
      snap,
    );
    expect(d.target.nm.slice(0, 3)).toEqual(['라벨', '칸코드', '13']);
    expect(d.reports.find((r) => r.rule === 'R01')).toMatchObject({
      field: 'nm3',
      before: '13.0',
      after: '13',
    });
    expect(d.r15).toBe('REVIEW');
    expect(d.target).toMatchObject({ physicalNm: null, reviewYn: true });
    expect(d.target.reviewNote).toContain('미등록 조각: 칸코드');
    expect(d.notFound).toEqual(['칸코드']);
  });
  it('미등록 조각 없음 → L1 물리명·접미어·설명 저장(RECALC)', () => {
    const d = decideDomain(
      row({
        nm: ['라벨', '코드', '1.0'],
        logicalNm: '라벨코드1',
        descr: 'not found',
        colType: 'VARCHAR',
        colLength: '10',
      }),
      snap,
    );
    expect(d.r15).toBe('RECALC');
    expect(d.target).toMatchObject({
      physicalNm: 'LABEL_CD1',
      suffix: 'CD',
      descr: '라벨_코드1',
      reviewYn: false,
    });
  });
  it('물리명 NULL + 타입 NULL(건마찰정보): 접미어(INFO)가 등록돼 있으면 타입은 재계산, 물리명은 review', () => {
    const d = decideDomain(
      row({ nm: ['건', '마찰', '정보'], logicalNm: '건마찰정보', suffix: 'INFO' }),
      snap,
    );
    expect(d.r15).toBe('REVIEW');
    expect(d.r5).toBe('RECALC');
    expect(d.target).toMatchObject({
      physicalNm: null,
      colType: 'VARCHAR',
      colLength: 200,
      reviewYn: true,
    });
  });
});

describe('R19 용어 기준 물리명 정정(CR-09: 마스터 MAST · 등록자 RGSRT)', () => {
  it('테이블명은 끝 조각 MST만 MAST로, 컬럼명은 등록자 기본컬럼 2개만', () => {
    expect(r19TableName('RP_RSCH_PRJ_MST')).toBe('RP_RSCH_PRJ_MAST');
    expect(r19TableName('RP_MST_HIST')).toBe('RP_MST_HIST');
    expect(r19TableName('RP_RSCH_PRJ_MAST')).toBe('RP_RSCH_PRJ_MAST');
    expect(r19TableName('RP_AMST')).toBe('RP_AMST');
    expect(r19ColumnName('FIRS_REG_USER_ID')).toBe('FIRS_RGSRT_ID');
    expect(r19ColumnName('FINA_REG_USER_ID')).toBe('FINA_RGSRT_ID');
    expect(r19ColumnName('REG_USER_ID')).toBe('REG_USER_ID');
    expect(r19ColumnName('RSCH_BUDG_MST_ID')).toBe('RSCH_BUDG_MST_ID');
  });
  it('계획: 바뀌는 테이블만, 정정 결과가 기존 이름과 겹치면 실패(멱등: 이미 새 이름이면 빈 계획)', () => {
    expect(
      planRenames([
        { tableNm: 'RP_A_MST', columns: ['A_ID', 'FIRS_REG_USER_ID'] },
        { tableNm: 'RP_B_LIST', columns: ['B_ID'] },
      ]),
    ).toEqual([
      {
        oldNm: 'RP_A_MST',
        newNm: 'RP_A_MAST',
        columns: [{ oldNm: 'FIRS_REG_USER_ID', newNm: 'FIRS_RGSRT_ID' }],
      },
    ]);
    expect(planRenames([{ tableNm: 'RP_A_MAST', columns: ['FIRS_RGSRT_ID'] }])).toEqual([]);
    expect(() =>
      planRenames([
        { tableNm: 'RP_A_MST', columns: [] },
        { tableNm: 'RP_A_MAST', columns: [] },
      ]),
    ).toThrow(/R19 테이블명 충돌/);
    expect(() =>
      planRenames([{ tableNm: 'RP_A', columns: ['FIRS_REG_USER_ID', 'FIRS_RGSRT_ID'] }]),
    ).toThrow(/R19 컬럼명 충돌/);
  });
});
