import { describe, expect, it } from 'vitest';
import { VALIDATION_CODES, type ValidationCode } from '@termflow/shared';
import type { ColumnModel, TableModel } from '../../src/ddl/model.js';
import {
  physicalSuffix,
  validateTable,
  type DesignContext,
  type ValidateContext,
} from '../../src/ddl/validator.js';
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
const SET: NonNullable<DesignContext['defaultSet']> = {
  setNm: '표준 감사',
  cols: [
    { defaultColId: 1, physicalNm: 'FIRS_REG_DTS' },
    { defaultColId: 2, physicalNm: 'FINA_REG_DTS' },
  ],
};
const design = (d: Partial<DesignContext> = {}): DesignContext => ({
  defaultSet: null,
  columnsByName: new Map(),
  ...d,
});
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
  ['W_DEFAULT_QUOTED', () => withCol({ defaultVal: "'N'" })],
  ['W_COMMENT_EMPTY', () => withCol({ colComment: null })],
  ['W_PREFIX_MISMATCH', () => ({ ...ok(), tableNm: 'AC_OK' })],
  ['W_VARCHAR_BYTES', () => withCol({ dataLength: 2000 })],
  ['W_DEFAULT_COLS_MISSING', ok, { design: design({ defaultSet: SET }) }],
  ['W_MATCH_MANUAL', ok, { design: design() }],
  ['W_MATCH_SIMILAR', () => withCol({ matchType: 'SIMILAR' }), { design: design() }],
  ['W_CODE_CLS_NONE', () => withCol({ physicalNm: 'EQP_TP_CD' }), { design: design() }],
  [
    'W_COMPOSED_KEY',
    () => ({
      ...ok(),
      columns: [
        col({ physicalNm: 'SITE_ID', isPk: true, isNullable: false, matchType: 'COMPOSED' }),
      ],
    }),
    { design: design() },
  ],
  [
    'W_COMPOSED_SHARED',
    () => withCol({ physicalNm: 'GW_ID', matchType: 'COMPOSED' }),
    {
      design: design({
        columnsByName: new Map([['GW_ID', [{ tableNm: 'DP_GW_MST', isPk: true }]]]),
      }),
    },
  ],
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

  it('설계 규칙(T18.12)은 design 문맥이 없으면 판정하지 않는다(DDL 생성 재검증)', () => {
    const t = withCol({ physicalNm: 'EQP_TP_CD', matchType: 'SIMILAR' });
    const got = codes(t);
    for (const c of ['W_MATCH_MANUAL', 'W_MATCH_SIMILAR', 'W_CODE_CLS_NONE'] as const)
      expect(got).not.toContain(c);
  });

  it('기본컬럼 누락: 세트 컬럼이 다 있거나 설명에 "기본컬럼 제외"면 경고 없음, 메시지에 빠진 물리명', () => {
    const ctx = { design: design({ defaultSet: SET }) };
    const r = validateTable(withCol({ physicalNm: 'FIRS_REG_DTS', defaultColId: 1 }), {
      ...CTX,
      ...ctx,
    });
    expect(r.warnings.find((w) => w.code === 'W_DEFAULT_COLS_MISSING')?.message).toBe(
      "기본컬럼 세트 '표준 감사'의 1개 컬럼이 없습니다(FINA_REG_DTS)",
    );
    const full: TableModel = {
      ...ok(),
      columns: [
        ...ok().columns,
        col({ physicalNm: 'FIRS_REG_DTS', defaultColId: 1, matchType: 'DEFAULT' }),
        col({ physicalNm: 'FINA_REG_DTS', defaultColId: 2, matchType: 'DEFAULT' }),
      ],
    };
    expect(codes(full, ctx)).not.toContain('W_DEFAULT_COLS_MISSING');
    expect(
      codes({ ...ok(), description: '수집 원시값. 기본컬럼 제외: 초당 수천 건' }, ctx),
    ).not.toContain('W_DEFAULT_COLS_MISSING');
  });

  it('코드구분 없는 CD: 코드구분 연결·도메인 있는 PK(코드 마스터 키)·마스터 키 참조는 예외', () => {
    const ctx = { design: design() };
    expect(codes(withCol({ physicalNm: 'EQP_TP_CD', codeClsId: 3 }), ctx)).not.toContain(
      'W_CODE_CLS_NONE',
    );
    // 코드 마스터 키: 도메인(EXACT) + PK
    const master: TableModel = {
      ...ok(),
      columns: [
        col({
          physicalNm: 'ALRM_CD',
          isPk: true,
          isNullable: false,
          domainId: 7,
          matchType: 'EXACT',
        }),
      ],
    };
    expect(codes(master, ctx)).not.toContain('W_CODE_CLS_NONE');
    // 도메인 없는 PK는 경고
    const noDomain: TableModel = {
      ...master,
      columns: [{ ...master.columns[0]!, domainId: null }],
    };
    expect(codes(noDomain, ctx)).toContain('W_CODE_CLS_NONE');
    // 다른 테이블에서 PK인 같은 물리명(코드 마스터 참조)
    const refCtx = {
      design: design({
        columnsByName: new Map([['ALRM_CD', [{ tableNm: 'GT_ALRM_CD', isPk: true }]]]),
      }),
    };
    const ref = withCol({ physicalNm: 'ALRM_CD', domainId: 7, matchType: 'EXACT' });
    expect(codes(ref, refCtx)).not.toContain('W_CODE_CLS_NONE');
    expect(codes(ref, ctx)).toContain('W_CODE_CLS_NONE');
  });

  it('COMPOSED 공유: 자기 테이블 행은 빼고, 다른 테이블명을 메시지에 보인다', () => {
    const self = {
      design: design({ columnsByName: new Map([['GW_ID', [{ tableNm: 'RP_OK', isPk: false }]]]) }),
    };
    expect(codes(withCol({ physicalNm: 'GW_ID', matchType: 'COMPOSED' }), self)).not.toContain(
      'W_COMPOSED_SHARED',
    );
    const many = {
      design: design({
        columnsByName: new Map([
          ['GW_ID', ['DP_A', 'DP_B', 'DP_C', 'DP_D'].map((tableNm) => ({ tableNm, isPk: false }))],
        ]),
      }),
    };
    const r = validateTable(withCol({ physicalNm: 'GW_ID', matchType: 'COMPOSED' }), {
      ...CTX,
      ...many,
    });
    expect(r.warnings.find((w) => w.code === 'W_COMPOSED_SHARED')?.message).toBe(
      'DP_A, DP_B, DP_C 외 1개에도 있는 컬럼이 도메인 없는 조합입니다. 도메인을 등록해 쓰세요',
    );
  });

  it('중복 물리명 메시지는 먼저 나온 행 번호(1-기준)', () => {
    const r = validateTable(withCol({ physicalNm: 'ID' }), CTX);
    expect(r.errors[0]?.message).toBe('물리명 ID가 1행과 중복됩니다');
  });
});
