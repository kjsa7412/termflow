import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LegacyTransformError, transformDump } from '../../src/migration/legacy-loader.js';
import { csvCell, REPORT_HEADER, ReportWriter, toCsv } from '../../src/migration/report-writer.js';
import { parseSteps } from '../../src/migration/runner.js';
import { parseArgs } from '../../src/migration/seed.js';
import { mask, parseValues, scanDump } from '../../src/migration/sensitive-scan.js';
import { HAS_LEGACY_DUMP, LEGACY_DUMP } from '../local-sources.js';

const BOM = String.fromCharCode(0xfeff);
describe('LOAD_LEGACY 치환 규칙 4개(T3.3, PoC T1.9)', () => {
  // 승계 원본 dump는 개발 PC에만 있다(저장소에 없음) — 없으면 실제 dump 치환 확인만 건너뛴다
  it.skipIf(!HAS_LEGACY_DUMP)('DB 블록 제거·스키마 legacy·OWNER 제거·public. 치환', () => {
    const out = transformDump(readFileSync(LEGACY_DUMP, 'utf8'));
    expect(out).not.toMatch(/^DROP DATABASE/m);
    expect(out).not.toMatch(/^\\connect/m);
    expect(out).toMatch(/^CREATE SCHEMA legacy;$/m);
    expect(out).not.toMatch(/COMMENT ON SCHEMA public/);
    expect(out).not.toMatch(/OWNER TO/);
    expect(out).not.toMatch(/\bpublic\./);
    expect(out.match(/^INSERT INTO legacy\./gm)).toHaveLength(8028);
  });
  it('기대 구조가 없으면 조용히 넘어가지 않고 실패', () => {
    expect(() => transformDump('CREATE SCHEMA public;')).toThrow(LegacyTransformError);
    expect(() =>
      transformDump(
        "DROP DATABASE x;\n\\connect x\nCREATE SCHEMA public;\nINSERT INTO public.t VALUES ('public.x');",
      ),
    ).toThrow(/데이터 값/);
  });
});

describe('리포트 CSV(T3.6, §11.3)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tf-report-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it('UTF-8 BOM + 고정 헤더 + CRLF, 쉼표·따옴표·개행 이스케이프, 수식 주입 방지', () => {
    const csv = toCsv(
      ['a', 'b'],
      [
        ['가,나', 'say "hi"'],
        ['=SUM(A1)', -3],
      ],
    );
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toBe(BOM + 'a,b\r\n"가,나","say ""hi"""\r\n\'=SUM(A1),-3\r\n');
    expect(csvCell(null)).toBe('');
    expect(csvCell('줄\n바꿈')).toBe('"줄\n바꿈"');
  });
  it('ReportWriter: 선언만 한 파일도 헤더만으로 생성(0건 증명)', () => {
    const w = new ReportWriter(dir, 'run-1');
    w.declare('r09_physical_normalized');
    w.add('r02_description_null', {
      rule: 'R02',
      step: 'TERM',
      legacyKey: 7,
      targetTable: 'std_term',
      targetId: 9,
      field: 'description',
      before: 'R',
      after: null,
      action: 'NULLED',
    });
    const files = w.flush();
    expect(files.map((f) => path.basename(f)).sort()).toEqual([
      'r02_description_null.csv',
      'r09_physical_normalized.csv',
    ]);
    expect(readdirSync(path.join(dir, 'run-1'))).toHaveLength(2);
    const empty = readFileSync(path.join(dir, 'run-1', 'r09_physical_normalized.csv'), 'utf8');
    expect(empty).toBe(`${BOM}${REPORT_HEADER.join(',')}\r\n`);
    const r02 = readFileSync(path.join(dir, 'run-1', 'r02_description_null.csv'), 'utf8');
    expect(r02.split('\r\n')[1]).toBe('R02,TERM,7,std_term,9,description,R,,NULLED,');
  });
});

describe('러너 인자(T3.2)', () => {
  it('parseSteps: 범위·목록·단일·빈 값, 순서는 §11.1', () => {
    expect(parseSteps('LOAD_LEGACY..DEFAULT_COL')).toEqual([
      'LOAD_LEGACY',
      'TEMPLATE',
      'BIZ_AREA',
      'DOMAIN_CLS',
      'TERM',
      'DOMAIN',
      'CODE',
      'DEFAULT_COL',
    ]);
    expect(parseSteps('term,template')).toEqual(['TEMPLATE', 'TERM']);
    expect(parseSteps('RECONCILE')).toEqual(['RECONCILE']);
    expect(parseSteps('')).toEqual([]);
    expect(() => parseSteps('NOPE')).toThrow(/알 수 없는 step/);
    expect(() => parseSteps('DOMAIN..TERM')).toThrow(/거꾸로/);
  });
  it('parseArgs: 기본 1차 범위 + RECONCILE 자동, --no-reconcile, --reset, pnpm의 -- 무시', () => {
    const a = parseArgs(['--', '--reset', '--run-id=abc-1']);
    expect(a).toMatchObject({ runId: 'abc-1', reset: true });
    expect(a.steps.at(-1)).toBe('RECONCILE');
    expect(a.steps).toHaveLength(9);
    expect(parseArgs(['--steps=TERM']).steps).toEqual(['TERM']);
    expect(parseArgs(['--steps=LOAD_LEGACY..DEFAULT_COL', '--no-reconcile']).steps).not.toContain(
      'RECONCILE',
    );
    expect(parseArgs([]).runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => parseArgs(['--run-id=a b'])).toThrow();
    expect(() => parseArgs(['--stepz=TERM'])).toThrow(/알 수 없는 인자/);
  });
});

describe('민감값 점검(T3.1)', () => {
  it('값 목록 파싱: 문자열 이스케이프·NULL·숫자', () => {
    expect(parseValues("'a', NULL, 3, 'it''s, ok', ''")).toEqual(['a', null, '3', "it's, ok", '']);
  });
  it('패턴: 주민번호·휴대전화·이메일 검출, epoch 13자리·루프백 IP는 제외', () => {
    const dump = [
      'CREATE TABLE public.t (',
      '    id character varying(50),',
      '    memo character varying(100),',
      '    firs_reg_ip character varying(50)',
      ');',
      "INSERT INTO public.t VALUES ('TBL_1774404849532', '연락처 010-1234-5678', '127.0.0.1');",
      "INSERT INTO public.t VALUES ('x', '900101-1234567 hong@example.com', '10.1.2.3');",
    ].join('\n');
    const r = scanDump(dump);
    expect(r.findings.map((f) => `${f.column}:${f.kind}`).sort()).toEqual([
      'firs_reg_ip:IP',
      'memo:EMAIL',
      'memo:MOBILE',
      'memo:RRN',
    ]);
    expect(r.userValues.get('t.firs_reg_ip')?.get('127.0.0.1')).toBe(1);
    expect(mask('900101-1234567')).toBe('90**********67');
  });
});
