import { sql, type InferInsertModel } from 'drizzle-orm';
import type { PgColumn, PgInsertValue, PgTable, PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { Audit } from '../common/audit/audit.js';
import type { Db } from './client.js';

/**
 * 감사 컬럼 채움(설계서 §8.6 "서비스 계층 명시 전달"). INSERT는 created_*·updated_*,
 * UPDATE는 updated_at = CURRENT_TIMESTAMP, updated_by, updated_ip.
 */
export function auditInsert(a: Audit) {
  return { createdBy: a.actor, createdIp: a.ip, updatedBy: a.actor, updatedIp: a.ip };
}

export function auditUpdate(a: Audit) {
  return { updatedAt: sql`CURRENT_TIMESTAMP`, updatedBy: a.actor, updatedIp: a.ip };
}

/** 감사 컬럼 6개를 가진 테이블(tf_user·tf_project·멤버·업무구분·std_* 7·prj_table·prj_column). */
export type AuditedTable = PgTable & {
  createdAt: PgColumn;
  createdBy: PgColumn;
  createdIp: PgColumn;
  updatedAt: PgColumn;
  updatedBy: PgColumn;
  updatedIp: PgColumn;
};

export type AuditColumn =
  'createdAt' | 'createdBy' | 'createdIp' | 'updatedAt' | 'updatedBy' | 'updatedIp';

/** 감사 컬럼을 뺀 insert 값 — 호출자가 감사 값을 직접 넣을 수 없다. */
// Omit<>은 InferInsertModel의 선택(?) 키를 잃는다 → 키 재매핑으로 수식어를 보존한다.
export type AuditedInsert<T extends AuditedTable> = {
  [K in keyof InferInsertModel<T> as K extends AuditColumn ? never : K]: InferInsertModel<T>[K];
};
export type AuditedPatch<T extends AuditedTable> = Partial<AuditedInsert<T>>;

/** Db 또는 트랜잭션(tx). */
export type DbExecutor = Pick<Db, 'insert' | 'update'>;

/**
 * 감사 대상 테이블 insert. `audit` 인자가 필수라 빠뜨리면 컴파일 오류(T2.5 DoD).
 * 반환 빌더에 `.returning()`·`.onConflictDoNothing()` 등을 이어 쓴다.
 */
export function insertAudited<T extends AuditedTable>(
  db: DbExecutor,
  table: T,
  values: AuditedInsert<T> | AuditedInsert<T>[],
  a: Audit,
) {
  const stamp = auditInsert(a);
  const rows = (Array.isArray(values) ? values : [values]).map((v) => ({ ...v, ...stamp }));
  return db.insert(table).values(rows as PgInsertValue<T>[]);
}

/** 감사 대상 테이블 update. `.where(...)`를 이어 쓴다. */
export function updateAudited<T extends AuditedTable>(
  db: DbExecutor,
  table: T,
  patch: AuditedPatch<T>,
  a: Audit,
) {
  return db.update(table).set({ ...patch, ...auditUpdate(a) } as PgUpdateSetSource<T>);
}
