import { describe, expect, it } from 'vitest';
import {
  DDL_OPTIONS_DEFAULT,
  ddlExtractRequestSchema,
  ddlOptionsSchema,
  ddlRequestSchema,
  exportLogSchema,
  tableDdlQuerySchema,
  tableListQuerySchema,
} from './ddl-options.js';

// T7.5 DdlOptions(§6.7) shared 스키마·DDL API 요청(§9.3)
describe('ddl-options 스키마', () => {
  it('기본값 = D15(대문자·스키마명 없음·DROP 미포함·코멘트 포함·비인용) + D14(코멘트 요약)', () => {
    expect(DDL_OPTIONS_DEFAULT).toEqual({
      schemaName: null,
      dropIfExists: false,
      includeComments: true,
      identifierCase: 'UPPER',
      quoteIdentifiers: false,
      codeColumnStyle: 'COMMENT_SUMMARY',
      fileSplit: 'SINGLE',
      lineEnding: 'LF',
      includeHeader: true,
      oracleCompat: '19c',
      mysqlTableOptions: 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
    });
  });

  it('schemaName: 대소문자 무관 입력 → 대문자, 빈 값 → null, 식별자 아니면 거부', () => {
    expect(ddlOptionsSchema.parse({ schemaName: ' rp ' }).schemaName).toBe('RP');
    expect(ddlOptionsSchema.parse({ schemaName: '' }).schemaName).toBeNull();
    expect(ddlOptionsSchema.parse({ schemaName: null }).schemaName).toBeNull();
    for (const bad of ['1rp', 'rp-x', 'rp;drop', 'a'.repeat(64)]) {
      expect(ddlOptionsSchema.safeParse({ schemaName: bad }).success, bad).toBe(false);
    }
  });

  it('P/ddl: tableIds · bizAreaIds · draft 중 하나 필요, 200 상한, output 3종', () => {
    expect(ddlRequestSchema.safeParse({}).success).toBe(false);
    expect(ddlRequestSchema.parse({ tableIds: [1] }).output).toBe('JSON');
    expect(ddlRequestSchema.parse({ bizAreaIds: [1], output: 'ZIP' }).options).toEqual(
      DDL_OPTIONS_DEFAULT,
    );
    const draft = ddlRequestSchema.parse({
      draft: { table: { bizAreaId: 1, tableNm: 'RP_A', tableLogicalNm: 'A' }, columns: [] },
    });
    expect(draft.draft?.table.tableNm).toBe('RP_A');
    expect(
      ddlRequestSchema.safeParse({ tableIds: Array.from({ length: 201 }, (_, i) => i + 1) })
        .success,
    ).toBe(false);
    expect(ddlRequestSchema.safeParse({ tableIds: [1], output: 'PDF' }).success).toBe(false);
    expect(ddlExtractRequestSchema.parse({ tableIds: [1] }).output).toBe('JSON');
  });

  it('GET P/tables/{id}/ddl 쿼리: 불리언 문자열·format', () => {
    const q = tableDdlQuerySchema.parse({ dropIfExists: 'true', includeComments: 'false' });
    expect(q).toMatchObject({ dropIfExists: true, includeComments: false, format: 'text' });
    expect(tableDdlQuerySchema.safeParse({ dropIfExists: 'yes' }).success).toBe(false);
  });

  it('export-logs: 클라이언트 기록은 COPY·EXTRACT만', () => {
    expect(exportLogSchema.parse({ kind: 'COPY', tableIds: [1] }).warningCnt).toBe(0);
    expect(exportLogSchema.safeParse({ kind: 'DOWNLOAD', tableIds: [1] }).success).toBe(false);
    expect(exportLogSchema.safeParse({ kind: 'COPY', tableIds: [] }).success).toBe(false);
  });

  it('GET P/tables 쿼리: 업무구분·상태·정렬 배열', () => {
    const q = tableListQuerySchema.parse({ bizAreaId: '3', status: 'FINAL', sort: 'tableNm,asc' });
    expect(q).toMatchObject({ bizAreaId: 3, status: 'FINAL', sort: ['tableNm,asc'], page: 1 });
    expect(tableListQuerySchema.safeParse({ status: 'X' }).success).toBe(false);
  });
});
