import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { AuditLogItem, AuditLogQuery, Page, StdEntityType } from '@termflow/shared';
import type { ProjectCtx } from '../common/project-context.js';
import type { Db } from '../db/client.js';
import { DRIZZLE } from '../db/db.module.js';
import { changedFields, isoTs, limitOffset, rowsOf, whereAll } from './std-sql.js';

interface Row {
  audit_id: string;
  entity_type: StdEntityType;
  entity_id: number;
  action: string;
  before_json: unknown;
  after_json: unknown;
  batch_id: string | null;
  actor: string;
  actor_ip: string | null;
  acted_at: string;
}

/**
 * 표준 사전 감사 로그 조회(T6.8, 설계서 §8.5) — 프로젝트 관리자. 용어·도메인 상세의 '변경이력'은
 * `entityType`+`entityId` 필터로 같은 API를 쓴다. COPY 요약 행은 entity_id가 프로젝트 ID라(CR-04 C10) 행 단위 이력 조회에서 뺀다.
 */
@Injectable()
export class AuditLogService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(ctx: ProjectCtx, q: AuditLogQuery): Promise<Page<AuditLogItem>> {
    const where = whereAll([
      sql`l.project_id = ${ctx.projectId}`,
      q.entityType ? sql`l.entity_type = ${q.entityType}` : undefined,
      q.entityId !== undefined
        ? sql`l.entity_id = ${q.entityId} and l.action <> 'COPY'`
        : undefined,
      q.action ? sql`l.action = ${q.action}` : undefined,
      q.actor ? sql`l.actor = ${q.actor}` : undefined,
      q.batchId ? sql`l.batch_id = ${q.batchId}` : undefined,
      q.from ? sql`l.acted_at >= ${q.from}::date` : undefined,
      q.to ? sql`l.acted_at < ${q.to}::date + 1` : undefined,
    ]);
    const [rows, [cnt]] = await Promise.all([
      rowsOf<Row>(
        this.db,
        sql`select l.audit_id, l.entity_type, l.entity_id, l.action, l.before_json, l.after_json, l.batch_id,
                   l.actor, l.actor_ip, ${isoTs(sql`l.acted_at`)} acted_at
              from std_audit_log l where ${where}
             order by l.acted_at desc, l.audit_id desc ${limitOffset(q)}`,
      ),
      rowsOf<{ n: number }>(
        this.db,
        sql`select count(*)::int n from std_audit_log l where ${where}`,
      ),
    ]);
    return {
      items: rows.map((r) => ({
        auditId: Number(r.audit_id),
        entityType: r.entity_type,
        entityId: r.entity_id,
        action: r.action,
        before: r.before_json,
        after: r.after_json,
        changedFields: changedFields(r.before_json, r.after_json),
        batchId: r.batch_id,
        actor: r.actor,
        actorIp: r.actor_ip,
        actedAt: r.acted_at,
      })),
      page: q.page,
      size: q.size,
      total: cnt?.n ?? 0,
    };
  }
}
