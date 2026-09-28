import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatValidationMessage, VALIDATION_CODES } from './codes.js';
import { checkIdentifier, DIALECT_IDENTIFIER_MAX } from './identifier.js';
import { checkPasswordPolicy } from './password.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const doc = readFileSync(path.resolve(here, '../../../../docs/02_설계서.md'), 'utf8')
  .split('\r\n')
  .join('\n');

/** 설계서 §5.7 표의 (코드, 구분) 행. */
function designCodeRows(): { code: string; severity: string }[] {
  const start = doc.indexOf('### 5.7 검증 규칙 코드표');
  const end = doc.indexOf('### 5.8', start);
  return doc
    .slice(start, end)
    .split('\n')
    .filter((l) => /^\| [EW]_[A-Z_]+ \|/.test(l))
    .map((l) => {
      const cells = l.split('|').map((c) => c.trim());
      return { code: cells[1]!, severity: cells[2]!.charAt(0) };
    });
}

describe('validation/codes (T2.10)', () => {
  it('코드표 행 수·코드·구분이 설계서 §5.7 표와 같다', () => {
    const rows = designCodeRows();
    expect(rows.length).toBe(30);
    expect(Object.keys(VALIDATION_CODES)).toEqual(rows.map((r) => r.code));
    for (const r of rows) {
      expect(VALIDATION_CODES[r.code as keyof typeof VALIDATION_CODES].severity).toBe(r.severity);
    }
  });

  it('메시지는 한국어이고 자리표시자를 채운다', () => {
    for (const def of Object.values(VALIDATION_CODES)) expect(def.message).toMatch(/[가-힣]/);
    expect(formatValidationMessage('E_PHYS_DUP', { physicalNm: 'RSCH_PRJ_ID', rowNo: 3 })).toBe(
      '물리명 RSCH_PRJ_ID이(가) 3행과 중복됩니다',
    );
    expect(formatValidationMessage('E_PHYS_LEN', { max: 63 })).toBe(
      '물리명이 63자를 초과합니다({dialect})',
    );
  });
});

describe('validation/identifier', () => {
  it('형식·방언 길이', () => {
    expect(DIALECT_IDENTIFIER_MAX).toEqual({ POSTGRESQL: 63, ORACLE: 30, MYSQL: 64 });
    expect(checkIdentifier('RP_RSCH_PRJ_MST', 'POSTGRESQL')).toBeNull();
    expect(checkIdentifier('', 'POSTGRESQL')).toBe('EMPTY');
    expect(checkIdentifier('rp_x', 'POSTGRESQL')).toBe('FORMAT');
    expect(checkIdentifier('1ABC', 'POSTGRESQL')).toBe('FORMAT');
    expect(checkIdentifier('X; DROP', 'POSTGRESQL')).toBe('FORMAT');
    expect(checkIdentifier('A'.repeat(31), 'ORACLE')).toBe('LENGTH');
    expect(checkIdentifier('A'.repeat(63), 'POSTGRESQL')).toBeNull();
    expect(checkIdentifier('A'.repeat(64), 'POSTGRESQL')).toBe('LENGTH');
  });
});

describe('validation/password (§7.6)', () => {
  it('길이·문자 종류·로그인 ID 포함', () => {
    expect(checkPasswordPolicy('abc12345', 'hong')).toEqual([]);
    expect(checkPasswordPolicy('ab1', 'hong')).toEqual(['PW_LENGTH']);
    expect(checkPasswordPolicy('abcdefgh', 'hong')).toEqual(['PW_CHAR_CLASSES']);
    expect(checkPasswordPolicy('xHong123!', 'hong')).toEqual(['PW_CONTAINS_LOGIN_ID']);
    expect(checkPasswordPolicy('a'.repeat(60) + '1234!', 'u')).toEqual(['PW_LENGTH']);
  });
});
