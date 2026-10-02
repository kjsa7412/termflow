import { describe, expect, it } from 'vitest';
import { VALIDATION_CODES, type ValidationCode } from '@termflow/shared';
import type { ColumnModel, TableModel } from '../../src/ddl/model.js';
import { physicalSuffix, validateTable, type ValidateContext } from '../../src/ddl/validator.js';
import { col, table } from './ddl-fixtures.js';

// T7.6 DoD: 코드표(§5.7) 중 테이블·컬럼 규칙 전 행 단위 테스트
const CTX: ValidateContext = { dialect: 'POSTGRESQL' };
const ok = (): TableModel =>
  table({
    tableNm: 'RP_OK',
    columns: [col({ physicalNm: 'ID', isPk: true, isNullable: false }), col({ physicalNm: 'NM' })],
  });
const withCol = (c: Partial<ColumnModel>, extra: Partial<TableModel> = {}): TableModel => {
  const t = ok();
  return { ...t, ...extra, columns: [t.columns[0]!, { ...t.columns[1]!, ...c }] };
};
const codes = (t: TableModel, ctx: Partial<ValidateContext> = {}) => {
  const r = validateTable(t, { ...CTX, ...ctx });
  return [...r.errors, ...r.warnings].map((i) => i.code);
};

describe('TableValidator — 기준 테이블', () => {
  it('정상 테이블은 오류·경고 0', () => {
    expect(validateTable(ok(), { ...CTX, suffixes: new Set(['ID', 'NM']) })).toEqual({
      errors: [],
      warnings: [],
    });
  });
});

/** 행: [코드, 테이블 모델, 문맥]. 모든 E/W 테이블·컬럼 규칙을 한 번 이상 일으킨다. */
const CASES: [ValidationCode, () => TableModel, Partial<ValidateContext>?][] = [
  ['E_LOGICAL_EMPTY', () => withCol({ logicalNm: ' ' })],
  ['E_PHYS_EMPTY', () => withCol({ physicalNm: '' })],
  ['E_PHYS_FORMAT', () => withCol({ physicalNm: 'nm' })],
  ['E_PHYS_FORMAT', () => ({ ...ok(), tableNm: 'rp-ok' })],
  ['E_PHYS_DUP', () => withCol({ physicalNm: 'ID' })],
  ['E_PHYS_LEN', () => withCol({ physicalNm: `A${'B'.repeat(63)}` })],
  ['E_PHYS_LEN', () => ({ ...ok(), tableNm: `RP_${'B'.repeat(61)}` })],
  ['E_RESERVED', () => withCol({ physicalNm: 'ORDER' })],
  ['E_RESERVED', () => ({ ...ok(), tableNm: 'USER', tablePrefix: null })],
  ['E_TYPE_MISSING', () => withCol({ dataType: null, dataLength: null })],
  ['E_TYPE_LEN_MISSING', () => withCol({ dataType: 'NUMERIC', dataLength: null })],
  ['E_TYPE_LEN_RANGE', () => withCol({ dataLength: 0 })],
  ['E_TYPE_LEN_RANGE', () => withCol({ dataType: 'NUMERIC', dataLength: 5, dataScale: 6 })],
  ['E_TYPE_LEN_RANGE', () => withCol({ dataType: 'TIMESTAMP', dataLength: 7 })],
  ['E_PK_NULLABLE', () => withCol({ isPk: true, isNullable: true })],
  ['E_TABLE_NM_DUP', ok, { otherTableNames: new Set(['RP_OK']) }],
  ['E_BIZ_AREA_REQUIRED', () => ({ ...ok(), bizAreaId: null })],
  ['W_PK_NONE', () => ({ ...ok(), columns: [col({ physicalNm: 'NM' })] })],
  ['W_TERM_UNREGISTERED', () => withCol({ matchType: 'UNREGISTERED' })],
  ['W_TERM_UNREGISTERED', () => withCol({ physicalNm: 'RSCH_?' })],
  ['W_TERM_PENDING', ok, { termHints: (_c, i) => (i === 1 ? { pending: ['책임자'] } : undefined) }],
  [
    'W_TERM_REJECTED',
    ok,
    { termHints: (_c, i) => (i === 1 ? { rejected: ['책임자'] } : undefined) },
  ],
  ['W_TERM_CHANGED', ok, { termHints: (_c, i) => (i === 1 ? { resegmented: 'NM2' } : undefined) }],
  [
    'W_DOMAIN_TYPE_CHANGED',
    () =>
      withCol({
        domainId: 9,
        domain: {
          domainId: 9,
          logicalNm: 'x',
          colType: 'VARCHAR',
          colLength: 30,
          colScale: null,
          reviewYn: false,
        },
      }),
  ],
  [
    'W_DOMAIN_REVIEW',
    () =>
      withCol({
        domainId: 9,
        domain: {
          domainId: 9,
          logicalNm: 'x',
          colType: 'VARCHAR',
          colLength: 20,
          colScale: null,
          reviewYn: true,
        },
      }),
  ],
  [
    'W_SUFFIX_UNREGISTERED',
    () => withCol({ physicalNm: 'PRJ_INFO' }),
    { suffixes: new Set(['ID', 'NM']) },
  ],
  ['W_CODE_CLS_MISSING', () => withCol({ matchType: 'CODE', codeClsId: null })],
  ['W_LEN_OTHER_DIALECT', () => withCol({ physicalNm: `A${'B'.repeat(30)}` })],
  ['W_LEN_OTHER_DIALECT', () => ({ ...ok(), tableNm: `RP_${'B'.repeat(28)}` })],
  ['W_RESERVED_OTHER', () => withCol({ physicalNm: 'SIZE' })],
  ['W_RESERVED_OTHER', () => ({ ...ok(), tableNm: 'LEVEL', tablePrefix: null })],
  ['W_DEFAULT_AS_STRING', () => withCol({ defaultVal: 'now()' })],
  ['W_COMMENT_EMPTY', () => withCol({ colComment: null })],
  ['W_PREFIX_MISMATCH', () => ({ ...ok(), tableNm: 'AC_OK' })],
  ['W_VARCHAR_BYTES', () => withCol({ dataLength: 2000 })],
];

describe('TableValidator — 코드표 전 행(§5.7)', () => {
  it.each(CASES.map(([c, t, x], i) => [`${i + 1}. ${c}`, c, t, x] as const))(
    '%s',
    (_n, code, build, extra) => {
      expect(codes(build(), extra ?? {})).toContain(code);
    },
  );

  it('테이블·컬럼 대상 E/W 코드가 모두 케이스에 있다(409 계열 제외)', () => {
    const covered = new Set(CASES.map(([c]) => c));
    const serviceOnly = new Set(['E_VERSION_CONFLICT', 'E_TABLE_FINAL', 'E_PROJECT_READONLY']);
    const all = (Object.keys(VALIDATION_CODES) as ValidationCode[]).filter(
      (c) => !serviceOnly.has(c),
    );
    expect(all.filter((c) => !covered.has(c))).toEqual([]);
  });

  it('E는 errors, W는 warnings에 들어가고 행·필드·테이블 정보를 담는다', () => {
    const r = validateTable(withCol({ physicalNm: 'ORDER', colComment: null, columnId: 55 }), {
      ...CTX,
    });
    expect(r.errors).toEqual([
      expect.objectContaining({
        code: 'E_RESERVED',
        target: 'column',
        rowIndex: 1,
        columnId: 55,
        columnNm: 'ORDER',
        field: 'physicalNm',
        tableNm: 'RP_OK',
        message: 'ORDER는 PostgreSQL 예약어입니다',
      }),
    ]);
    expect(r.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['W_RESERVED_OTHER', 'W_COMMENT_EMPTY']),
    );
  });

  it('quoteIdentifiers=true면 예약어 판정을 건너뛴다(§6.4 "인용 옵션이면 통과")', () => {
    expect(codes(withCol({ physicalNm: 'ORDER' }), { quoteIdentifiers: true })).not.toContain(
      'E_RESERVED',
    );
  });

  it('기본 방언이 다르면 E/W가 바뀐다(Oracle 기본: 30자 초과는 E, PostgreSQL 예약어는 W)', () => {
    const t = withCol({ physicalNm: `A${'B'.repeat(30)}` });
    expect(codes(t, { dialect: 'ORACLE' })).toContain('E_PHYS_LEN');
    expect(codes(withCol({ physicalNm: 'OFFSET' }), { dialect: 'ORACLE' })).toContain(
      'W_RESERVED_OTHER',
    );
  });

  it('기본컬럼(defaultColId)은 도메인 타입 비교·접미어 판정 제외, 접미어는 끝 숫자를 뗀다', () => {
    const dflt = withCol({
      physicalNm: 'WRK_RMK',
      defaultColId: 3,
      dataLength: 50,
      domainId: 9,
      domain: {
        domainId: 9,
        logicalNm: 'x',
        colType: 'VARCHAR',
        colLength: 20,
        colScale: null,
        reviewYn: false,
      },
    });
    const got = codes(dflt, { suffixes: new Set(['ID']) });
    expect(got).not.toContain('W_SUFFIX_UNREGISTERED');
    expect(got).not.toContain('W_DOMAIN_TYPE_CHANGED');
    expect(physicalSuffix('WRK_ADDR1')).toBe('ADDR');
    expect(physicalSuffix('MEMO')).toBe('MEMO');
    expect(physicalSuffix('A_1')).toBeNull();
  });

  it('중복 물리명 메시지는 먼저 나온 행 번호(1-기준)', () => {
    const r = validateTable(withCol({ physicalNm: 'ID' }), CTX);
    expect(r.errors[0]?.message).toBe('물리명 ID가 1행과 중복됩니다');
  });
});
