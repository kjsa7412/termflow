import { describe, expect, it } from 'vitest';
import { parseStdType, parseTypeAndLength, typeText } from '../../src/standard/std-type-parser.js';

// T3.4 StdTypeParser(R16, 설계서 §11.2): 예시 5종 + 경계
describe('StdTypeParser — R16 예시 5종', () => {
  it.each([
    ['VARCHAR(20)', 'VARCHAR', 20, null, 'VARCHAR(20)'],
    ['NUMERIC(6,2)', 'NUMERIC', 6, 2, 'NUMERIC(6,2)'],
    ['TIMESTAMP(0)', 'TIMESTAMP', 0, null, 'TIMESTAMP(0)'],
    ['JSONB', 'JSONB', null, null, 'JSONB'],
    ['VARCHAR(5.0)', 'VARCHAR', 5, null, 'VARCHAR(5)'],
  ])('%s → (%s, %s, %s)', (input, type, length, scale, normalized) => {
    expect(parseStdType(input)).toEqual({ ok: true, type, length, scale, normalized });
  });
});

describe('StdTypeParser — 별칭·정리', () => {
  it('INTEGER → INT, VARCHAR2 → VARCHAR(CR-03), 소문자·공백 허용', () => {
    expect(parseStdType('INTEGER')).toMatchObject({ ok: true, type: 'INT', length: null });
    expect(parseStdType('VARCHAR2(4000)')).toMatchObject({
      ok: true,
      type: 'VARCHAR',
      length: 4000,
    });
    expect(parseStdType(' numeric( 13, 2 ) ')).toMatchObject({
      ok: true,
      type: 'NUMERIC',
      length: 13,
      scale: 2,
    });
  });
  it('TIMESTAMP n 없음 → length NULL', () => {
    expect(parseStdType('TIMESTAMP')).toMatchObject({ ok: true, type: 'TIMESTAMP', length: null });
  });
});

describe('StdTypeParser — 경계·실패', () => {
  it.each([
    ['', 'EMPTY'],
    [null, 'EMPTY'],
    ['VARCHAR(', 'FORMAT'],
    ['VARCHAR(10.5)', 'FORMAT'],
    ['VARHCAR(3)', 'UNKNOWN_TYPE'],
    ['NUMBER(10)', 'UNKNOWN_TYPE'],
    ['VARCHAR', 'LEN_MISSING'],
    ['NUMERIC', 'LEN_MISSING'],
    ['VARCHAR(0)', 'LEN_RANGE'],
    ['NUMERIC(4,6)', 'LEN_RANGE'],
    ['TIMESTAMP(7)', 'LEN_RANGE'],
    ['BIGINT(20)', 'SCALE_NOT_ALLOWED'],
    ['VARCHAR(10,2)', 'SCALE_NOT_ALLOWED'],
  ])('%s → %s', (input, reason) => {
    expect(parseStdType(input)).toMatchObject({ ok: false, reason });
  });
  it('TIMESTAMP(6)은 허용 상한', () => {
    expect(parseStdType('TIMESTAMP(6)')).toMatchObject({ ok: true, length: 6 });
  });
});

describe('parseTypeAndLength — R3 입력(타입 + 길이 문자열)', () => {
  it('길이 문자열 정수화·precision/scale 분리', () => {
    expect(parseTypeAndLength('VARCHAR', '100.0')).toMatchObject({
      ok: true,
      type: 'VARCHAR',
      length: 100,
    });
    expect(parseTypeAndLength('NUMERIC', '7,4')).toMatchObject({ ok: true, length: 7, scale: 4 });
    expect(parseTypeAndLength('BIGINT', null)).toMatchObject({
      ok: true,
      type: 'BIGINT',
      length: null,
    });
    expect(parseTypeAndLength('TIMESTAMP(0)', '')).toMatchObject({
      ok: true,
      type: 'TIMESTAMP',
      length: 0,
    });
  });
  it('괄호 타입 + 길이 문자열 동시 지정은 형식 오류', () => {
    expect(parseTypeAndLength('TIMESTAMP(0)', '3')).toMatchObject({ ok: false, reason: 'FORMAT' });
  });
});

describe('typeText(L1 9단계)', () => {
  it('타입별 표시 규칙', () => {
    expect(typeText('VARCHAR', 20, null)).toBe('VARCHAR(20)');
    expect(typeText('CHAR', 1, null)).toBe('CHAR(1)');
    expect(typeText('NUMERIC', 10, null)).toBe('NUMERIC(10)');
    expect(typeText('NUMERIC', 6, 2)).toBe('NUMERIC(6,2)');
    expect(typeText('TIMESTAMP', null, null)).toBe('TIMESTAMP');
    expect(typeText('TIMESTAMP', 0, null)).toBe('TIMESTAMP(0)');
    expect(typeText('BIGINT', 10, null)).toBe('BIGINT');
    expect(typeText(null, null, null)).toBeNull();
  });
});
