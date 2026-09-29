/**
 * DDL 구문 강조(목업 10 `.code` — kw·ty·id·str·num·cm, T7.12). 서버가 만든 문자열을 **토큰으로 나눠 표시만** 한다(P4).
 * v-html을 쓰지 않는다 — 토큰 배열을 텍스트 노드로 렌더링하므로 코멘트·리터럴 안의 문자가 마크업이 되지 않는다.
 */
export type TokenKind = 'kw' | 'ty' | 'id' | 'str' | 'num' | 'cm' | '';
export interface Token {
  k: TokenKind;
  v: string;
}

const KEYWORDS = new Set([
  'CREATE',
  'TABLE',
  'DROP',
  'IF',
  'EXISTS',
  'NOT',
  'NULL',
  'DEFAULT',
  'CONSTRAINT',
  'PRIMARY',
  'KEY',
  'CHECK',
  'IN',
  'COMMENT',
  'ON',
  'COLUMN',
  'IS',
  'TRUE',
  'FALSE',
]);
const TYPES = new Set([
  'VARCHAR',
  'CHAR',
  'TEXT',
  'SMALLINT',
  'INTEGER',
  'BIGINT',
  'NUMERIC',
  'DATE',
  'TIMESTAMP',
  'BOOLEAN',
  'JSONB',
  'BYTEA',
]);

/** 한 줄 → 토큰(인접한 같은 종류는 합친다). */
export function tokenizeLine(line: string): Token[] {
  const out: Token[] = [];
  const push = (k: TokenKind, v: string) => {
    const last = out[out.length - 1];
    if (last && last.k === k) last.v += v;
    else out.push({ k, v });
  };
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === '-' && line[i + 1] === '-') {
      push('cm', line.slice(i));
      break;
    }
    if (ch === "'") {
      let j = i + 1;
      for (; j < line.length; j++) {
        if (line[j] === "'") {
          if (line[j + 1] === "'") j++;
          else break;
        }
      }
      push('str', line.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (ch === '"' || ch === '`') {
      const j = line.indexOf(ch, i + 1);
      const end = j < 0 ? line.length : j + 1;
      push('id', line.slice(i, end));
      i = end;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(line.slice(i));
    if (word) {
      const w = word[0];
      const up = w.toUpperCase();
      push(KEYWORDS.has(up) ? 'kw' : TYPES.has(up) ? 'ty' : 'id', w);
      i += w.length;
      continue;
    }
    const num = /^-?\d+(\.\d+)?/.exec(line.slice(i));
    if (num && !/[A-Za-z0-9_]/.test(line[i - 1] ?? '')) {
      push('num', num[0]);
      i += num[0].length;
      continue;
    }
    push('', ch);
    i++;
  }
  return out;
}

export function tokenize(sql: string): Token[][] {
  const lines = sql.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  return lines.map(tokenizeLine);
}
