import type { AuditAction, StdEntityType } from '@termflow/shared';
import type { Audit } from '../common/audit/audit.js';
import type { Db } from '../db/client.js';
import { stdAuditLog } from '../db/schema.js';

/** 감사 JSON에서 뺄 감사 컬럼(§8.5 "before/after JSON(감사컬럼 제외)"). */
const AUDIT_KEYS = new Set([
  'createdAt',
  'createdBy',
  'createdIp',
  'updatedAt',
  'updatedBy',
  'updatedIp',
]);

/** 행 객체 → 감사 JSON(감사 컬럼 제외). */
export function auditJson(row: Record<string, unknown> | null | undefined): unknown {
  if (!row) return null;
  return Object.fromEntries(Object.entries(row).filter(([k]) => !AUDIT_KEYS.has(k)));
}

export interface StdAuditEntry {
  projectId: number;
  entityType: StdEntityType;
  entityId: number;
  action: AuditAction;
  before?: unknown;
  after?: unknown;
  batchId?: string | null;
}

/** 표준 사전 감사 로그(§3.5.14·§8.5, 프로젝트 범위) 기록. 서비스 쓰기와 같은 트랜잭션에서 부른다. */
export async function writeStdAudit(
  q: Pick<Db, 'insert'>,
  entries: StdAuditEntry | StdAuditEntry[],
  a: Audit,
): Promise<void> {
  const list = Array.isArray(entries) ? entries : [entries];
  if (list.length === 0) return;
  await q.insert(stdAuditLog).values(
    list.map((e) => ({
      projectId: e.projectId,
      entityType: e.entityType,
      entityId: e.entityId,
      action: e.action,
      beforeJson: e.before ?? null,
      afterJson: e.after ?? null,
      batchId: e.batchId ?? null,
      actor: a.actor,
      actorIp: a.ip,
    })),
  );
}
