import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';
import { audit, clientIp, MIGRATION_AUDIT, SYSTEM_AUDIT } from '../../src/common/audit/audit.js';
import { insertAudited, updateAudited } from '../../src/db/audit.js';
import { fullSchema } from '../../src/db/client.js';
import { stdTerm, tfUser } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';

// T2.5 감사 규약(§8.6): Audit 인자 필수(컴파일 오류), 시스템 주체, SQL에 감사 컬럼 포함
const db = drizzle.mock({ schema: fullSchema, casing: 'snake_case' });

describe('Audit', () => {
  it('시스템 주체 SYSTEM·MIGRATION, 빈 주체 거부, 길이 제한', () => {
    expect(SYSTEM_AUDIT).toEqual({ actor: 'SYSTEM', ip: null });
    expect(MIGRATION_AUDIT).toEqual({ actor: 'MIGRATION', ip: null });
    expect(() => audit('  ')).toThrow();
    expect(audit('u'.repeat(60), '1'.repeat(50)).actor).toHaveLength(50);
    expect(audit('u', '1'.repeat(50)).ip).toHaveLength(45);
  });

  it('clientIp: X-Forwarded-For 첫 값 → 원격 주소, ::ffff: 제거', () => {
    expect(clientIp({ headers: { 'x-forwarded-for': '10.0.0.7, 172.16.0.1' } })).toBe('10.0.0.7');
    expect(clientIp({ headers: {}, ip: '::ffff:127.0.0.1' })).toBe('127.0.0.1');
    expect(clientIp({ headers: {}, socket: { remoteAddress: '::1' } })).toBe('::1');
    expect(clientIp({ headers: {} })).toBeNull();
  });
});

describe('insertAudited / updateAudited', () => {
  const a = audit('hong', '10.0.0.7');

  it('INSERT에 created_*·updated_*를 채운다', () => {
    const q = insertAudited(
      db,
      stdTerm,
      { projectId: 1, termKor: '연구', termPhysical: 'RSCH' },
      a,
    ).toSQL();
    expect(q.sql).toMatch(/"created_by", "created_ip", "updated_at", "updated_by", "updated_ip"/);
    expect(q.params).toEqual(expect.arrayContaining(['hong', '10.0.0.7']));
    expect(q.params.filter((p) => p === 'hong')).toHaveLength(2);
  });

  it('UPDATE는 updated_at = CURRENT_TIMESTAMP, updated_by, updated_ip', () => {
    const q = updateAudited(db, tfUser, { userNm: '홍길동' }, SYSTEM_AUDIT)
      .where(eq(tfUser.userId, 1))
      .toSQL();
    expect(q.sql).toMatch(/"updated_at" = CURRENT_TIMESTAMP/);
    expect(q.sql).toMatch(/"updated_by" = \$\d/);
    expect(q.params).toContain('SYSTEM');
  });

  it('타입: Audit 인자 누락·감사 컬럼 직접 지정은 컴파일 오류', () => {
    // 아래 두 줄은 pnpm typecheck에서 @ts-expect-error가 "오류 있음"을 확인한다(없으면 typecheck 실패).
    // @ts-expect-error -- audit 인자 누락
    const missing = () => insertAudited(db, stdTerm, { projectId: 1, termKor: 'x' });
    const direct = () =>
      insertAudited(
        db,
        stdTerm,
        // @ts-expect-error -- createdBy는 AuditedInsert에서 제외된다
        { projectId: 1, termKor: 'x', createdBy: 'me' },
        a,
      );
    // @ts-expect-error -- 감사 컬럼이 없는 테이블(로그)은 AuditedTable이 아니다
    const logTable = () => updateAudited(db, fullSchema.stdAuditLog, {}, a);
    expect([missing, direct, logTable]).toHaveLength(3);
  });
});
