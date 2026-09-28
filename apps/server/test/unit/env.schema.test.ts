import { describe, expect, it } from 'vitest';
import {
  DEV_ADMIN_PASSWORD,
  DEV_SESSION_SECRET,
  parseEnv,
  sessionTimeoutMs,
} from '../../src/config/env.schema.js';

// T2.4 설정 모듈: 누락·형식 오류·prod 필수(§2.8, §12.5, 부록 B.3)
const valid = {
  TERMFLOW_DB_URL: 'postgres://localhost:5434/termflow',
  TERMFLOW_DB_PASSWORD: 'pw',
};
const prodSecret = 'x'.repeat(32);

describe('parseEnv', () => {
  it('필수 값(DB URL·비밀번호)만 있으면 기본값을 채워 통과한다(dev)', () => {
    const result = parseEnv(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env).toMatchObject({
      NODE_ENV: 'development',
      PORT: 8080,
      TERMFLOW_DB_USER: 'termflow',
      DB_POOL_MAX: 10,
      TERMFLOW_ADMIN_LOGIN: 'admin',
      TERMFLOW_ADMIN_PASSWORD: DEV_ADMIN_PASSWORD,
      TERMFLOW_SESSION_SECRET: DEV_SESSION_SECRET,
      TERMFLOW_SESSION_TIMEOUT: '60m',
      LOCKOUT_MAX: 5,
      LOCKOUT_MINUTES: 15,
      TERMFLOW_UPLOAD_MAX_MB: 10,
      TERMFLOW_DEFAULT_DIALECT: 'POSTGRESQL',
      TERMFLOW_ORACLE_COMPAT: '19c',
      TERMFLOW_TEST_DIALECTS: '',
      TERMFLOW_CACHE_MAX_PROJECTS: 20,
      TERMFLOW_LEGACY_DUMP: '/seed/dump-gen_table-new.sql',
      TERMFLOW_REPORT_DIR: './migration/report',
      LOG_LEVEL: 'info',
    });
    expect(result.env.usedDevDefaults).toEqual([
      'TERMFLOW_ADMIN_PASSWORD',
      'TERMFLOW_SESSION_SECRET',
    ]);
    expect(sessionTimeoutMs(result.env)).toBe(3_600_000);
  });

  it('누락·빈 문자열 변수명을 모두 돌려준다', () => {
    const result = parseEnv({ TERMFLOW_DB_PASSWORD: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual(['TERMFLOW_DB_PASSWORD', 'TERMFLOW_DB_URL']);
    }
  });

  it('형식 오류: 포트·풀 크기·방언·세션 만료·DB URL·테스트 방언', () => {
    const result = parseEnv({
      ...valid,
      TERMFLOW_DB_URL: 'jdbc:postgresql://db:5432/termflow',
      PORT: '70000',
      DB_POOL_MAX: '0',
      TERMFLOW_DEFAULT_DIALECT: 'SQLITE',
      TERMFLOW_SESSION_TIMEOUT: '60',
      TERMFLOW_TEST_DIALECTS: 'oracle,db2',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual([]);
      expect(result.invalid.map((i) => i.name).sort()).toEqual([
        'DB_POOL_MAX',
        'PORT',
        'TERMFLOW_DB_URL',
        'TERMFLOW_DEFAULT_DIALECT',
        'TERMFLOW_SESSION_TIMEOUT',
        'TERMFLOW_TEST_DIALECTS',
      ]);
    }
  });

  it('production: 관리자 비밀번호 필수, 세션 비밀값 32바이트 이상', () => {
    const noAdmin = parseEnv({
      ...valid,
      NODE_ENV: 'production',
      TERMFLOW_SESSION_SECRET: prodSecret,
    });
    expect(noAdmin.ok).toBe(false);
    if (!noAdmin.ok) expect(noAdmin.missing).toEqual(['TERMFLOW_ADMIN_PASSWORD']);

    const shortSecret = parseEnv({
      ...valid,
      NODE_ENV: 'production',
      TERMFLOW_ADMIN_PASSWORD: 'Adm1n!pass',
      TERMFLOW_SESSION_SECRET: 'short',
    });
    expect(shortSecret.ok).toBe(false);
    if (!shortSecret.ok) {
      expect(shortSecret.invalid.map((i) => i.name)).toEqual(['TERMFLOW_SESSION_SECRET']);
    }

    // 한글 11자 = 33바이트 → 통과(글자 수가 아닌 바이트 기준)
    const ok = parseEnv({
      ...valid,
      NODE_ENV: 'production',
      TERMFLOW_ADMIN_PASSWORD: 'Adm1n!pass',
      TERMFLOW_SESSION_SECRET: '가나다라마바사아자차카',
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.env.usedDevDefaults).toEqual([]);
  });
});
