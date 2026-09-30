import { describe, expect, it } from 'vitest';
import { ddlOptionsSchema, type DdlOptions } from '@termflow/shared';
import { dialectFor } from '../../src/ddl/dialects.js';
import {
  fileStamp,
  generateBundle,
  generateTable,
  warningSummary,
} from '../../src/ddl/generator.js';
import { col, designExample68, META_68, RP_RSCH_PRJ_MAST_68, table } from './ddl-fixtures.js';

// T7.5 옵션 조합, T7.7 §6.8 예시 문자열 일치(생성기 + TableModel)
const pg = dialectFor('POSTGRESQL');
const opts = (o: Partial<DdlOptions> = {}): DdlOptions => ddlOptionsSchema.parse(o);
const gen = (t = RP_RSCH_PRJ_MAST_68, o: Partial<DdlOptions> = {}) =>
  generateTable(pg, { model: t, warnings: [] }, opts(o), META_68).sql;

describe('generator — §6.8 예시(T7.7)', () => {
  it('기본 옵션(D15) 출력이 설계서 §6.8 PostgreSQL 예시와 문자 단위로 같다', () => {
    expect(gen()).toBe(designExample68());
  });
});

describe('generator — 옵션 조합(T7.5)', () => {
  const small = table({
    tableNm: 'RP_T',
    logicalNm: '테스트',
    columns: [
      col({ physicalNm: 'ID', logicalNm: '아이디', isPk: true, isNullable: false }),
      col({
        physicalNm: 'STAT_CD',
        logicalNm: '상태코드',
        dataLength: 10,
        codeClsId: 7,
        matchType: 'CODE',
        codeClsRef: {
          codeClsId: 7,
          bizCd: 'RP',
          codeCls: '040',
          codeClsNm: '상태',
          codes: [
            { code: '01', codeNm: '계획' },
            { code: "0'2", codeNm: '진행' },
          ],
        },
      }),
    ],
  });

  it('includeHeader=false면 헤더 없이 CREATE로 시작한다', () => {
    expect(gen(small, { includeHeader: false }).startsWith('CREATE TABLE RP_T (')).toBe(true);
  });

  it('includeComments=false면 COMMENT ON이 없다', () => {
    const s = gen(small, { includeComments: false });
    expect(s).not.toContain('COMMENT ON');
    expect(s.trimEnd().endsWith(');')).toBe(true);
  });

  it('dropIfExists=true면 CREATE 앞에 DROP TABLE IF EXISTS(기본은 미포함, D15)', () => {
    expect(gen(small)).not.toContain('DROP');
    const s = gen(small, { dropIfExists: true, includeHeader: false });
    expect(s.split('\n').slice(0, 2)).toEqual([
      'DROP TABLE IF EXISTS RP_T;',
      'CREATE TABLE RP_T (',
    ]);
  });

  it('schemaName은 테이블·코멘트·DROP 모두에 붙는다(입력 대소문자 무관 → 대문자 규칙)', () => {
    const s = gen(small, { schemaName: 'rp', dropIfExists: true, includeHeader: false });
    expect(s).toContain('DROP TABLE IF EXISTS RP.RP_T;');
    expect(s).toContain('CREATE TABLE RP.RP_T (');
    expect(s).toContain('COMMENT ON TABLE  RP.RP_T IS');
    expect(s).toContain('COMMENT ON COLUMN RP.RP_T.ID IS');
  });

  it('identifierCase=LOWER는 식별자만 소문자(키워드·타입은 대문자)', () => {
    const s = gen(small, { identifierCase: 'LOWER', includeHeader: false });
    expect(s).toContain('CREATE TABLE rp_t (');
    expect(s).toContain('    id                   VARCHAR(20)    NOT NULL,');
    expect(s).toContain('CONSTRAINT pk_rp_t PRIMARY KEY (id)');
  });

  it('quoteIdentifiers=true는 모든 식별자를 인용하고 헤더에 주의 문구를 넣는다', () => {
    const s = gen(small, { quoteIdentifiers: true });
    expect(s).toContain('CREATE TABLE "RP_T" (');
    expect(s).toContain('CONSTRAINT "PK_RP_T" PRIMARY KEY ("ID")');
    expect(s).toContain('COMMENT ON COLUMN "RP_T"."ID" IS');
    expect(s.split('\n')[1]).toMatch(/^-- 주의: 인용 식별자/);
    const lower = gen(small, { quoteIdentifiers: true, identifierCase: 'LOWER' });
    expect(lower).toContain('CREATE TABLE "rp_t" (');
  });

  it('codeColumnStyle: COMMENT_SUMMARY(기본) / CHECK / NONE(D14)', () => {
    const summary = gen(small, { includeHeader: false });
    expect(summary).toContain(
      "COMMENT ON COLUMN RP_T.STAT_CD IS '상태코드(RP/040: 01 계획, 0''2 진행)';",
    );
    expect(summary).not.toContain('CHECK');

    const check = gen(small, { codeColumnStyle: 'CHECK', includeHeader: false });
    expect(check).toContain("    CONSTRAINT CK_RP_T_STAT_CD CHECK (STAT_CD IN ('01', '0''2'))");
    expect(check).toContain("COMMENT ON COLUMN RP_T.STAT_CD IS '상태코드';");
    expect(check.indexOf('PRIMARY KEY')).toBeLessThan(check.indexOf('CHECK ('));

    const none = gen(small, { codeColumnStyle: 'NONE', includeHeader: false });
    expect(none).toContain("COMMENT ON COLUMN RP_T.STAT_CD IS '상태코드';");
    expect(none).not.toContain('CHECK');
  });

  it('코드 요약은 활성 코드 최대 10개, 초과 시 …', () => {
    const codes = Array.from({ length: 12 }, (_, i) => ({
      code: String(i + 1).padStart(2, '0'),
      codeNm: `값${i + 1}`,
    }));
    const t = table({
      tableNm: 'RP_T',
      columns: [
        col({
          physicalNm: 'A_CD',
          logicalNm: '가코드',
          codeClsId: 1,
          codeClsRef: { codeClsId: 1, bizCd: 'RP', codeCls: '001', codeClsNm: '가', codes },
        }),
      ],
    });
    const s = gen(t, { includeHeader: false });
    expect(s).toContain('10 값10, …)');
    expect(s).not.toContain('11 값11');
    const empty = table({
      tableNm: 'RP_T',
      columns: [
        col({
          physicalNm: 'A_CD',
          logicalNm: '가코드',
          codeClsId: 1,
          codeClsRef: { codeClsId: 1, bizCd: 'RP', codeCls: '001', codeClsNm: '가', codes: [] },
        }),
      ],
    });
    expect(gen(empty, { includeHeader: false })).toContain("IS '가코드(RP/001)';");
    expect(gen(empty, { includeHeader: false, codeColumnStyle: 'CHECK' })).not.toContain('CHECK');
  });

  it('lineEnding=CRLF는 모든 줄 끝을 CRLF로', () => {
    const s = gen(small, { lineEnding: 'CRLF' });
    expect(s.endsWith("';\r\n")).toBe(true);
    expect(s.replaceAll('\r\n', '')).not.toContain('\n');
  });

  it('경고는 헤더에 요약 줄로 들어간다(§6.10)', () => {
    const s = generateTable(
      pg,
      {
        model: small,
        warnings: [
          { code: 'W_PK_NONE', message: 'x' },
          { code: 'W_COMMENT_EMPTY', message: 'y' },
          { code: 'W_COMMENT_EMPTY', message: 'z' },
        ],
      },
      opts(),
      META_68,
    ).sql;
    expect(s.split('\n')[1]).toBe('-- 경고 3건: W_COMMENT_EMPTY 2, W_PK_NONE 1');
    expect(warningSummary([])).toBeNull();
  });

  it('긴 이름은 가장 긴 값 + 1로 열을 맞춘다', () => {
    const t = table({
      tableNm: 'RP_T',
      columns: [
        col({ physicalNm: 'A_VERY_LONG_COLUMN_NAME_X', isNullable: false }),
        col({ physicalNm: 'B' }),
      ],
    });
    const lines = gen(t, { includeHeader: false }).split('\n');
    expect(lines[1]).toBe('    A_VERY_LONG_COLUMN_NAME_X  VARCHAR(20)    NOT NULL,');
    expect(lines[2]).toBe('    B                          VARCHAR(20)');
  });

  it('PK 제약명이 63자를 넘으면 축약 + W_CONSTRAINT_NM_SHORTENED', () => {
    const long = `RP_${'X'.repeat(58)}`; // 61자 → PK_ 붙이면 64
    const out = generateTable(
      pg,
      {
        model: table({
          tableNm: long,
          columns: [col({ physicalNm: 'ID', isPk: true, isNullable: false })],
        }),
        warnings: [],
      },
      opts({ includeHeader: false }),
      META_68,
    );
    const m = /CONSTRAINT (\S+) PRIMARY KEY/.exec(out.sql);
    expect(m?.[1]).toMatch(/^PK_RP_X{21}[0-9A-F]{4}$/);
    expect(m?.[1]?.length).toBe(31);
    expect(out.warnings.map((w) => w.code)).toEqual(['W_CONSTRAINT_NM_SHORTENED']);
  });
});

describe('generator — 다중 테이블(§6.10)', () => {
  const a = table({ tableNm: 'RP_A', logicalNm: 'A', columns: [col({ physicalNm: 'ID' })] });
  const b = table({
    tableNm: 'AC_B',
    logicalNm: 'B',
    bizCd: 'AC',
    status: 'DRAFT',
    version: 3,
    columns: [col({ physicalNm: 'ID' })],
  });
  const c = table({ tableNm: 'RP_C', logicalNm: 'C', columns: [col({ physicalNm: 'ID' })] });
  const inputs = [a, b, c].map((model) => ({ model, warnings: [] }));

  it('SINGLE: 헤더 1개 + 블록을 빈 줄 2개로 구분, 블록 제목 `-- i/n 물리명 논리명 (vN, 상태)`', () => {
    const r = generateBundle(pg, inputs, opts(), META_68);
    const lines = r.sql.split('\n');
    expect(lines[0]).toBe(
      '-- TermFlow DDL | 프로젝트 RMS 연구관리시스템(이관) · 업무구분 RP, AC | 방언 POSTGRESQL | 2026-09-28 14:00 | hong',
    );
    expect(lines[1]).toBe('-- 1/3 RP_A A (v1, FINAL)');
    expect(r.sql).toContain(
      "COMMENT ON COLUMN RP_A.ID IS 'ID';\n\n\n-- 2/3 AC_B B (v3, DRAFT)\nCREATE TABLE AC_B (",
    );
    expect(r.sql.match(/-- TermFlow DDL/g)).toHaveLength(1);
  });

  it('SINGLE + dropIfExists: DROP은 역순으로 앞에 모은다', () => {
    const r = generateBundle(
      pg,
      inputs,
      opts({ dropIfExists: true, includeHeader: false }),
      META_68,
    );
    expect(
      r.sql.startsWith(
        'DROP TABLE IF EXISTS RP_C;\nDROP TABLE IF EXISTS AC_B;\nDROP TABLE IF EXISTS RP_A;\n\n\n-- 1/3',
      ),
    ).toBe(true);
    expect(r.sql.match(/DROP TABLE/g)).toHaveLength(3);
  });

  it('PER_TABLE: `{BIZ_CD}/{NN}_{TABLE}.sql`(업무구분 폴더별 순번) + _warnings.txt, 파일명 규칙', () => {
    const r = generateBundle(pg, inputs, opts({ dropIfExists: true }), META_68);
    expect(r.perTableFiles.map((f) => f.name)).toEqual([
      'RP/01_RP_A.sql',
      'AC/01_AC_B.sql',
      'RP/02_RP_C.sql',
      '_warnings.txt',
    ]);
    expect(r.perTableFiles[0]!.content).toBe(r.tables[0]!.sql);
    expect(r.perTableFiles[0]!.content).toContain(
      'DROP TABLE IF EXISTS RP_A;\nCREATE TABLE RP_A (',
    );
    expect(r.singleFileName).toBe('RMS_POSTGRESQL_20260928_1400.sql');
    expect(r.zipFileName).toBe('RMS_POSTGRESQL_20260928_1400.zip');
    expect(fileStamp('2026-01-02 03:04')).toBe('20260102_0304');
  });

  it('테이블 1개면 SINGLE = 단일 테이블 파일(GET P/tables/{id}/ddl과 같다)', () => {
    const r = generateBundle(pg, [inputs[0]!], opts(), META_68);
    expect(r.sql).toBe(r.tables[0]!.sql);
    expect(r.sql).not.toContain('-- 1/1');
  });
});
