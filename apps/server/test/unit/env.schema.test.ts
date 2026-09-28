import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/config/env.schema.js';

const valid = {
  TERMFLOW_DB_URL: 'postgres://localhost:5434/termflow',
  TERMFLOW_DB_USER: 'termflow',
  TERMFLOW_DB_PASSWORD: 'pw',
  TERMFLOW_ADMIN_PASSWORD: 'admin-pw',
};

describe('parseEnv', () => {
  it('필수 값이 있으면 기본값을 채워 통과한다', () => {
    const result = parseEnv(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env.PORT).toBe(8080);
      expect(result.env.TERMFLOW_ADMIN_LOGIN).toBe('admin');
      expect(result.env.TERMFLOW_DEFAULT_DIALECT).toBe('POSTGRESQL');
    }
  });

  it('누락·빈 문자열 변수명을 모두 돌려준다', () => {
    const result = parseEnv({ TERMFLOW_DB_URL: 'x', TERMFLOW_DB_PASSWORD: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual([
        'TERMFLOW_ADMIN_PASSWORD',
        'TERMFLOW_DB_PASSWORD',
        'TERMFLOW_DB_USER',
      ]);
    }
  });

  it('production에서 짧은 세션 비밀값은 형식 오류다', () => {
    const result = parseEnv({ ...valid, NODE_ENV: 'production', TERMFLOW_SESSION_SECRET: 'short' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.invalid.map((i) => i.name)).toEqual(['TERMFLOW_SESSION_SECRET']);
    }
  });
});
