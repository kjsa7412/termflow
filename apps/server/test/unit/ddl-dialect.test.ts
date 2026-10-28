import { describe, expect, it } from 'vitest';
import { DDL_OPTIONS_DEFAULT, DIALECTS, DIALECT_IDENTIFIER_MAX, STD_TYPES } from '@termflow/shared';
import { classifyDefault } from '../../src/ddl/defaults.js';
import { constraintName, UnsafeIdentifierError } from '../../src/ddl/dialect.js';
import { dialectFor, UnsupportedDialectError } from '../../src/ddl/dialects.js';
import {
  isReserved,
  parseReservedFile,
  renderReservedFile,
  reservedFileHeader,
  reservedWords,
} from '../../src/ddl/reserved-words.js';
import {
  mapStdType,
  parseTypeMapping,
  renderPattern,
  typeMapping,
} from '../../src/ddl/type-mapping.js';
import { HAS_DESIGN_DOC } from '../local-sources.js';
import { col, designTypeTable, table } from './ddl-fixtures.js';

const pg = dialectFor('POSTGRESQL');
const O = DDL_OPTIONS_DEFAULT;

describe('DdlDialect(PostgreSQL) — 메서드별(T7.1)', () => {
  it('id·identifierMaxLength·terminator', () => {
    expect(pg.id()).toBe('POSTGRESQL');
    expect(pg.identifierMaxLength()).toBe(63);
    expect(pg.terminator()).toBe(';');
    expect(pg.blockTerminator()).toBe(';');
    expect(pg.inlineComment('x')).toBeUndefined();
  });

  it('Oracle·MySQL은 구현 자리만(D2) → UnsupportedDialectError', () => {
    expect(() => dialectFor('ORACLE')).toThrow(UnsupportedDialectError);
    expect(() => dialectFor('MYSQL')).toThrow(UnsupportedDialectError);
  });

  it('identifier: 대소문자·인용(§6.4), 정규식 위반은 생성 중단(인젝션 방지)', () => {
    expect(pg.identifier('RP_A', O)).toBe('RP_A');
    expect(pg.identifier('RP_A', { ...O, identifierCase: 'LOWER' })).toBe('rp_a');
    expect(pg.identifier('RP_A', { ...O, quoteIdentifiers: true })).toBe('"RP_A"');
    for (const bad of ['X; DROP TABLE Y', 'rp_a', '1A', 'A"B', '', 'A-B', 'ＡＢ']) {
      expect(() => pg.identifier(bad, O)).toThrow(UnsafeIdentifierError);
    }
    expect(pg.qualifiedName('T', { ...O, schemaName: 'S1' })).toBe('S1.T');
  });

  it('literal: 작은따옴표 두 번, 개행·탭(연속) → 공백 1개, 역슬래시는 그대로(§6.5)', () => {
    expect(pg.literal("고객's 메모")).toBe("'고객''s 메모'");
    expect(pg.literal('a\r\nb\tc\n\nd')).toBe("'a b c d'");
    expect(pg.literal('C:\\temp\\')).toBe("'C:\\temp\\'");
    expect(pg.literal('x\u0000y')).toBe("'x y'");
    expect(pg.literal('')).toBe("''");
  });

  it('renderDefault: 화이트리스트·리터럴(§6.6)', () => {
    const r = (v: string | null) => pg.renderDefault(classifyDefault(v), 'VARCHAR');
    expect(r(null)).toBeUndefined();
    expect(r('  ')).toBeUndefined();
    expect(r('null')).toBe('NULL');
    expect(r('NULL')).toBe('NULL');
    expect(r('0')).toBe('0');
    expect(r('-1.5')).toBe('-1.5');
    expect(r('CURRENT_TIMESTAMP')).toBe('CURRENT_TIMESTAMP');
    expect(r('NOW()')).toBe('CURRENT_TIMESTAMP');
    expect(r('CURRENT_DATE')).toBe('CURRENT_DATE');
    expect(r('SYSDATE')).toBe('CURRENT_DATE');
    expect(r('TRUE')).toBe('TRUE');
    expect(r('FALSE')).toBe('FALSE');
    expect(r('N')).toBe("'N'");
    expect(r('now()')).toBe("'now()'");
    expect(r("nextval('s')")).toBe("'nextval(''s'')'");
    expect(r('1e5')).toBe("'1e5'");
  });

  it('classifyDefault: 함수처럼 보이는 문자열 표시(W_DEFAULT_AS_STRING 근거)', () => {
    expect(classifyDefault('now()')).toEqual({
      kind: 'STRING',
      value: 'now()',
      looksLikeFunction: true,
    });
    expect(classifyDefault('Y')).toEqual({ kind: 'STRING', value: 'Y', looksLikeFunction: false });
    expect(classifyDefault(' 12 ')).toEqual({ kind: 'NUMBER', value: '12' });
  });

  it('columnDefinition: NOT NULL → DEFAULT 순서, PK는 NOT NULL', () => {
    const w = { name: 20, type: 14 };
    expect(
      pg.columnDefinition(
        col({ physicalNm: 'END_YN', dataLength: 1, isNullable: false, defaultVal: 'N' }),
        O,
        w,
      ),
    ).toBe("    END_YN               VARCHAR(1)     NOT NULL DEFAULT 'N'");
    expect(pg.columnDefinition(col({ physicalNm: 'ID', isPk: true, isNullable: true }), O, w)).toBe(
      '    ID                   VARCHAR(20)    NOT NULL',
    );
    expect(pg.columnDefinition(col({ physicalNm: 'A' }), O, w)).toBe(
      '    A                    VARCHAR(20)',
    );
  });

  it('createTable·comments·dropTable·checkConstraint', () => {
    const t = table({
      tableNm: 'RP_T',
      logicalNm: "테'이블",
      columns: [
        col({ physicalNm: 'ID', isPk: true, isNullable: false }),
        col({ physicalNm: 'NM', colComment: null, logicalNm: '이름' }),
      ],
    });
    expect(pg.createTable(t, O).sql).toBe(
      'CREATE TABLE RP_T (\n    ID                   VARCHAR(20)    NOT NULL,\n    NM                   VARCHAR(20),\n    CONSTRAINT PK_RP_T PRIMARY KEY (ID)\n);',
    );
    expect(pg.comments(t, O)).toEqual([
      "COMMENT ON TABLE  RP_T IS '테''이블';",
      "COMMENT ON COLUMN RP_T.ID IS 'ID';",
      "COMMENT ON COLUMN RP_T.NM IS '이름';",
    ]);
    expect(pg.dropTable('RP_T', true, O)).toBe('DROP TABLE IF EXISTS RP_T;');
    expect(pg.dropTable('RP_T', false, O)).toBe('DROP TABLE RP_T;');
    const codes = {
      codeClsId: 1,
      bizCd: 'RP',
      codeCls: '1',
      codeClsNm: 'x',
      codes: [{ code: 'A', codeNm: 'a' }],
    };
    expect(pg.checkConstraint(t, t.columns[1]!, codes, O)?.sql).toBe(
      "CONSTRAINT CK_RP_T_NM CHECK (NM IN ('A'))",
    );
    expect(pg.checkConstraint(t, t.columns[1]!, { ...codes, codes: [] }, O)).toBeUndefined();
  });

  it('constraintName: 길이 이내는 그대로, 넘으면 앞 24자 + 해시 4자', () => {
    expect(constraintName('PK', 'RP_A', 63)).toEqual({ name: 'PK_RP_A', shortened: false });
    const s = constraintName('CK', 'A'.repeat(40) + '_' + 'B'.repeat(30), 63);
    expect(s.shortened).toBe(true);
    expect(s.name).toMatch(/^CK_A{24}[0-9A-F]{4}$/);
    expect(constraintName('CK', 'A'.repeat(40) + '_' + 'B'.repeat(30), 63)).toEqual(s);
  });

  it('reservedWords: 파일 목록(대소문자 무시·전체 일치)', () => {
    expect(pg.reservedWords().has('ORDER')).toBe(true);
    expect(isReserved('POSTGRESQL', 'order')).toBe(true);
    expect(isReserved('POSTGRESQL', 'ORDER_NO')).toBe(false);
    expect(isReserved('POSTGRESQL', 'WRK_DESC')).toBe(false);
  });
});

describe('매핑 YAML(T7.2)', () => {
  it('StdType 12종 × 3방언 행이 모두 있다', () => {
    for (const d of DIALECTS) {
      const m = typeMapping(d);
      expect(m.dialect).toBe(d);
      expect(Object.keys(m.types).sort()).toEqual([...STD_TYPES].sort());
      expect(m.identifierMaxLength).toBe(DIALECT_IDENTIFIER_MAX[d]);
    }
  });

  it('PostgreSQL 매핑(§6.3 표)', () => {
    const m = typeMapping('POSTGRESQL');
    const t = (
      type: (typeof STD_TYPES)[number],
      n: number | null = null,
      s: number | null = null,
    ) => mapStdType(m, type, n, s).sql;
    expect(t('VARCHAR', 20)).toBe('VARCHAR(20)');
    expect(t('CHAR', 1)).toBe('CHAR(1)');
    expect(t('TEXT')).toBe('TEXT');
    expect(t('SMALLINT')).toBe('SMALLINT');
    expect(t('INT')).toBe('INTEGER');
    expect(t('BIGINT')).toBe('BIGINT');
    expect(t('NUMERIC', 6, 2)).toBe('NUMERIC(6,2)');
    expect(t('NUMERIC', 10)).toBe('NUMERIC(10)');
    expect(t('DATE')).toBe('DATE');
    expect(t('TIMESTAMP', 0)).toBe('TIMESTAMP(0)');
    expect(t('TIMESTAMP')).toBe('TIMESTAMP');
    expect(t('BOOLEAN')).toBe('BOOLEAN');
    expect(t('JSONB')).toBe('JSONB');
    expect(t('BYTEA')).toBe('BYTEA');
    expect(mapStdType(m, 'VARCHAR', 20000, null).warnings).toEqual([]);
  });

  // 설계서는 개발 PC에만 있다(저장소에 없음)
  it.skipIf(!HAS_DESIGN_DOC)(
    '설계서 §6.3 표의 셀과 3방언 YAML 기본 표현이 같다(데이터 일관성)',
    () => {
      const rows = designTypeTable();
      expect(rows).toHaveLength(12);
      const sample: Record<string, [number | null, number | null]> = {
        VARCHAR: [20, null],
        CHAR: [1, null],
        NUMERIC: [6, 2],
        TIMESTAMP: [0, null],
      };
      for (const row of rows) {
        const type = row.type.replace(/\(.*$/, '') as (typeof STD_TYPES)[number];
        const [n, s] = sample[type] ?? [null, null];
        const cells = { POSTGRESQL: row.pg, ORACLE: row.oracle, MYSQL: row.mysql } as const;
        for (const d of DIALECTS) {
          const got = mapStdType(typeMapping(d), type, n, s).sql;
          // 표 셀은 `PATTERN(n)` 표기 — 첫 백틱 구간을 샘플 값으로 채워 비교
          const cell = /`([^`]+)`/.exec(cells[d])?.[1] ?? '';
          const expected = cell
            .replace('(n)', n !== null ? `(${n})` : '')
            .replace('(n CHAR)', `(${n} CHAR)`)
            .replace('(p[,s])', `(${n},${s})`)
            .replace('(p,s)', `(${n},${s})`);
          expect(got, `${d} ${type}`).toBe(expected);
        }
      }
    },
  );

  it('Oracle·MySQL 대체 타입·경고(데이터)', () => {
    const o = typeMapping('ORACLE');
    expect(mapStdType(o, 'VARCHAR', 5000, null)).toMatchObject({
      sql: 'CLOB',
      warnings: [{ code: 'W_TYPE_OVERFLOW' }],
    });
    expect(mapStdType(o, 'VARCHAR', 2000, null)).toMatchObject({
      sql: 'VARCHAR2(2000 CHAR)',
      warnings: [{ code: 'W_VARCHAR_BYTES' }],
    });
    expect(mapStdType(typeMapping('MYSQL'), 'VARCHAR', 20000, null).sql).toBe('TEXT');
  });

  it('renderPattern: 선택 구간 [ ]·필수 자리표시자', () => {
    expect(renderPattern('NUMERIC({p}[,{s}])', { n: 5, p: 5, s: null })).toBe('NUMERIC(5)');
    expect(renderPattern('TIMESTAMP[({n})]', { n: null, p: null, s: null })).toBe('TIMESTAMP');
    expect(() => renderPattern('VARCHAR({n})', { n: null, p: null, s: null })).toThrow();
  });

  it('zod 로더: 누락 타입·잘못된 패턴은 거부', () => {
    expect(() =>
      parseTypeMapping('dialect: POSTGRESQL\nidentifierMaxLength: 63\nquote: "\\""\ntypes: {}\n'),
    ).toThrow(/검증 실패/);
    const ok = "dialect: POSTGRESQL\nidentifierMaxLength: 63\nquote: '\"'\n";
    const types = STD_TYPES.map((t) => `  ${t}: { pattern: "X; DROP" }`).join('\n');
    expect(() =>
      parseTypeMapping(
        `${ok}types:\n${types}\ndefaults: { CURRENT_TIMESTAMP: a, CURRENT_DATE: b, "TRUE": c, "FALSE": d }\ncolumnAttributeOrder: [NULLABILITY, DEFAULT]\n`,
      ),
    ).toThrow(/허용되지 않은 문자/);
  });
});

describe('예약어 리소스(T7.4)', () => {
  it('파일 주석에 출처·버전, PostgreSQL은 pg_get_keywords R·T', () => {
    const h = reservedFileHeader('POSTGRESQL').join('\n');
    expect(h).toContain("pg_get_keywords() catcode 'R'");
    expect(h).toMatch(/버전: PostgreSQL 17\./);
    for (const d of ['ORACLE', 'MYSQL'] as const)
      expect(reservedFileHeader(d).join('\n')).toContain('출처:');
    expect(reservedWords('POSTGRESQL').size).toBeGreaterThan(90);
    for (const w of ['ORDER', 'USER', 'TABLE', 'LEFT', 'DESC', 'SELECT'])
      expect(isReserved('POSTGRESQL', w)).toBe(true);
    for (const w of ['SIZE', 'LEVEL', 'COMMENT', 'NAME', 'VALUE'])
      expect(isReserved('POSTGRESQL', w)).toBe(false);
    expect(isReserved('ORACLE', 'SIZE')).toBe(true);
    expect(isReserved('MYSQL', 'KEY')).toBe(true);
  });

  it('생성·파싱 왕복(생성 일시 없음 → 같은 입력이면 같은 파일)', () => {
    const text = renderReservedFile('17.9', ['order', 'ALL', 'ALL']);
    expect(text).toBe(renderReservedFile('17.9', ['ALL', 'ORDER']));
    expect([...parseReservedFile(text)]).toEqual(['ALL', 'ORDER']);
  });
});
