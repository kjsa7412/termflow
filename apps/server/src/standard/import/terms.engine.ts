import { eq, sql } from 'drizzle-orm';
import {
  normalizeAbbr,
  normalizeTermKor,
  STD_WARNING_CODES,
  validateTermFields,
  type ImportIssue,
} from '@termflow/shared';
import type { Audit } from '../../common/audit/audit.js';
import { insertAudited } from '../../db/audit.js';
import { stdTerm } from '../../db/schema.js';
import { auditJson, writeStdAudit } from '../std-audit.js';
import { chunks } from '../std-sql.js';
import { diff, FileKeys, finish, issue, optText, type KindEngine, type Planned } from './engine.js';

type TermRow = typeof stdTerm.$inferSelect;
interface State {
  byKor: Map<string, TermRow>;
  byPhysical: Map<string, string[]>;
}
interface Op {
  existing: TermRow | null;
  termKor: string;
  termPhysical: string;
  description: string | null;
  synonymRef: string | null;
}

/**
 * 용어 일괄 등록(§9.4: 한글용어* · 물리약어* · 설명 · 동의어참조). 키 = 한글용어(라틴 대문자 정규화).
 * 신규는 APPROVED(프로젝트 관리자 일괄 등록, §4.5). 갱신은 물리약어 + 값이 있는 선택 열만 바꾼다(빈 칸 = 기존 값 유지).
 * 같은 물리약어를 쓰는 다른 용어(기존·파일)는 경고 `W_TERM_PHYSICAL_SHARED`(R8, 허용).
 */
export const termsEngine: KindEngine<State, Op> = {
  kind: 'terms',
  entityType: 'TERM',
  title: '용어',
  columns: [
    { key: 'termKor', label: '한글용어', required: true },
    { key: 'termPhysical', label: '물리약어', required: true },
    { key: 'description', label: '설명', required: false },
    { key: 'synonymRef', label: '동의어참조', required: false },
  ],
  example: ['위원회', 'CMTE', 'Committee', '위원'],
  notes: [
    '한글용어가 이미 있으면 갱신(물리약어·설명·동의어참조), 없으면 신규(승인 상태)로 등록합니다.',
    '물리약어는 영대문자·숫자·_만, 30자 이내입니다. 빈 설명·동의어참조 칸은 기존 값을 유지합니다.',
  ],

  async load(q, projectId): Promise<State> {
    const rows = await q.select().from(stdTerm).where(eq(stdTerm.projectId, projectId));
    const byPhysical = new Map<string, string[]>();
    for (const r of rows) {
      if (!r.termPhysical) continue;
      byPhysical.set(r.termPhysical, [...(byPhysical.get(r.termPhysical) ?? []), r.termKor]);
    }
    return { byKor: new Map(rows.map((r) => [r.termKor, r])), byPhysical };
  },

  plan(rows, state): Planned<Op>[] {
    const keys = new FileKeys();
    const filePhys = new Map<string, string[]>();
    const pre = rows.map((r) => {
      const errors: ImportIssue[] = [];
      const termKor = normalizeTermKor(r.cells['termKor'] ?? '');
      const termPhysical = normalizeAbbr(r.cells['termPhysical']);
      for (const e of validateTermFields(termKor, termPhysical))
        errors.push(issue(e.code, e.message, e.field));
      const description = optText(r.cells, 'description', '설명', 500, errors);
      const synonymRef = optText(r.cells, 'synonymRef', '동의어참조', 200, errors);
      if (termKor !== '') keys.claim(termKor, r.rowNo, errors, '한글용어');
      if (errors.length === 0 && termPhysical)
        filePhys.set(termPhysical, [...(filePhys.get(termPhysical) ?? []), termKor]);
      return { r, errors, termKor, termPhysical, description, synonymRef };
    });
    return pre.map(({ r, errors, termKor, termPhysical, description, synonymRef }) => {
      const existing = state.byKor.get(termKor) ?? null;
      const changes: Record<string, [unknown, unknown]> = {};
      if (existing) {
        diff(changes, 'termPhysical', existing.termPhysical, termPhysical);
        diff(changes, 'description', existing.description, description ?? undefined);
        diff(changes, 'synonymRef', existing.synonymRef, synonymRef ?? undefined);
      }
      const warnings: ImportIssue[] = [];
      if (termPhysical && errors.length === 0) {
        const others = [
          ...(state.byPhysical.get(termPhysical) ?? []),
          ...(filePhys.get(termPhysical) ?? []),
        ].filter((k, i, arr) => k !== termKor && arr.indexOf(k) === i);
        if (others.length > 0)
          warnings.push(
            issue(
              'W_TERM_PHYSICAL_SHARED',
              `${STD_WARNING_CODES.W_TERM_PHYSICAL_SHARED}: ${others.slice(0, 5).join(', ')}${others.length > 5 ? ` 외 ${others.length - 5}` : ''}`,
              'termPhysical',
            ),
          );
      }
      return finish(
        {
          rowNo: r.rowNo,
          key: termKor,
          values: { termKor, termPhysical, description, synonymRef },
          changes,
          errors,
          warnings,
        },
        existing === null,
        {
          existing,
          termKor,
          termPhysical: termPhysical ?? '',
          description: description ?? existing?.description ?? null,
          synonymRef: synonymRef ?? existing?.synonymRef ?? null,
        },
      );
    });
  },

  async apply(tx, projectId, rows, _state, a: Audit, batchId) {
    const ops = rows.flatMap((p) => (p.op ? [p.op] : []));
    const inserts = ops.filter((o) => o.existing === null);
    const updates = ops.filter((o) => o.existing !== null);
    for (const part of chunks(inserts, 500)) {
      const created = await insertAudited(
        tx,
        stdTerm,
        part.map((o) => ({
          projectId,
          termKor: o.termKor,
          termPhysical: o.termPhysical,
          description: o.description,
          synonymRef: o.synonymRef,
          status: 'APPROVED',
        })),
        a,
      ).returning();
      await writeStdAudit(
        tx,
        created.map((r) => ({
          projectId,
          entityType: 'TERM' as const,
          entityId: r.termId,
          action: 'IMPORT' as const,
          after: auditJson(r),
          batchId,
        })),
        a,
      );
    }
    for (const part of chunks(updates, 1000)) {
      await tx.execute(
        sql`update std_term t
               set term_physical = u.p, description = u.d, synonym_ref = u.s,
                   updated_at = CURRENT_TIMESTAMP, updated_by = ${a.actor}, updated_ip = ${a.ip}
              from unnest(${sql.param(part.map((o) => o.existing!.termId))}::int[],
                          ${sql.param(part.map((o) => o.termPhysical))}::text[],
                          ${sql.param(part.map((o) => o.description))}::text[],
                          ${sql.param(part.map((o) => o.synonymRef))}::text[]) as u(id, p, d, s)
             where t.term_id = u.id and t.project_id = ${projectId}`,
      );
      await writeStdAudit(
        tx,
        part.map((o) => {
          const before = auditJson(o.existing) as Record<string, unknown>;
          return {
            projectId,
            entityType: 'TERM' as const,
            entityId: o.existing!.termId,
            action: 'IMPORT' as const,
            before,
            after: {
              ...before,
              termPhysical: o.termPhysical,
              description: o.description,
              synonymRef: o.synonymRef,
            },
            batchId,
          };
        }),
        a,
      );
    }
    return { new: inserts.length, update: updates.length };
  },
};
