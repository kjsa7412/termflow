import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { audit, MIGRATION_AUDIT, SYSTEM_AUDIT } from '../../src/common/audit/audit.js';
import { findPgError } from '../../src/common/problem/problem-detail.filter.js';
import { insertAudited, updateAudited } from '../../src/db/audit.js';
import { tfProject, tfUser } from '../../src/db/schema.js';
import { useTestDb } from './setup/databases.js';

// T2.5 DoD: 감사 헬퍼로 감사 컬럼이 채워지고, 누락은 DB NOT NULL로도 검출(이중 검출). 트랜잭션에서도 동작.
const t = useTestDb('t_audit');

describe('감사 규약 — DB (T2.5)', () => {
  it('insertAudited: created_*·updated_* 채움, SYSTEM·MIGRATION 주체', async () => {
    const [u] = await insertAudited(
      t.db,
      tfUser,
      { loginId: 'boot', userNm: '부트스트랩', passwordHash: 'x' },
      SYSTEM_AUDIT,
    ).returning();
    expect(u).toMatchObject({
      createdBy: 'SYSTEM',
      updatedBy: 'SYSTEM',
      createdIp: null,
      pwChangeRequired: true,
    });
    expect(u?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/); // mode 'string'
    const [p] = await insertAudited(
      t.db,
      tfProject,
      { projectKey: 'STDV1', projectNm: '기본 표준', kind: 'TEMPLATE' },
      MIGRATION_AUDIT,
    ).returning({ createdBy: tfProject.createdBy });
    expect(p?.createdBy).toBe('MIGRATION');
  });

  it('updateAudited: updated_at 갱신·updated_by/ip, created_*는 그대로 — 트랜잭션 안에서', async () => {
    await t.pool.query(
      "update tf_user set updated_at = now() - interval '1 day' where login_id = 'boot'",
    );
    const r = await t.db.transaction(async (tx) =>
      updateAudited(tx, tfUser, { userNm: '관리자' }, audit('hong', '10.0.0.7'))
        .where(eq(tfUser.loginId, 'boot'))
        .returning(),
    );
    expect(r[0]).toMatchObject({
      userNm: '관리자',
      createdBy: 'SYSTEM',
      updatedBy: 'hong',
      updatedIp: '10.0.0.7',
    });
    const age = await t.pool.query<{ fresh: boolean }>(
      "select updated_at > now() - interval '1 minute' fresh from tf_user where login_id='boot'",
    );
    expect(age.rows[0]?.fresh).toBe(true);
  });

  it('헬퍼를 거치지 않은 insert(감사 누락)는 NOT NULL 위반 23502', async () => {
    const e = await t.db
      .insert(tfUser)
      // 타입 우회(스키마상 createdBy 필수) — 런타임 이중 검출 확인용
      .values({ loginId: 'raw', userNm: '누락', passwordHash: 'x' } as never)
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    expect(findPgError(e)?.code).toBe('23502');
  });
});
