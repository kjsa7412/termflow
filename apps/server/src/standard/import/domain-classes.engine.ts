import { eq, sql } from 'drizzle-orm';
import {
  isStdType,
  normalizeAbbr,
  typeText,
  type ImportIssue,
  type StdType,
} from '@termflow/shared';
import { insertAudited } from '../../db/audit.js';
import { stdDomainCls } from '../../db/schema.js';
import { validateDomainCls } from '../domain-cls.service.js';
import { auditJson, writeStdAudit } from '../std-audit.js';
import { chunks } from '../std-sql.js';
import {
  diff,
  FileKeys,
  finish,
  intCell,
  issue,
  optText,
  reqText,
  type KindEngine,
  type Planned,
} from './engine.js';

type ClsRow = typeof stdDomainCls.$inferSelect;
interface State {
  bySuffix: Map<string, ClsRow>;
}
interface Op {
  existing: ClsRow | null;
  values: {
    suffix: string;
    clsNm: string;
    colType: StdType;
    colLength: number | null;
    colScale: number | null;
    description: string | null;
  };
}

const TYPE_ALIASES: Readonly<Record<string, StdType>> = { INTEGER: 'INT', VARCHAR2: 'VARCHAR' };

/** 타입 이름 셀 → 표준 타입(대문자·별칭 INTEGER→INT, VARCHAR2→VARCHAR). */
export function typeCell(
  cells: Record<string, string | null>,
  key: string,
  label: string,
  errors: ImportIssue[],
  required: boolean,
): StdType | null {
  const raw = (cells[key] ?? '').trim().toUpperCase();
  if (raw === '') {
    if (required) errors.push(issue('E_REQUIRED', `${label}이(가) 비어 있습니다`, key));
    return null;
  }
  const t = TYPE_ALIASES[raw] ?? raw;
  if (!isStdType(t)) {
    errors.push(
      issue('E_TYPE_UNKNOWN', `${label} '${cells[key]}'는 표준 타입 12종이 아닙니다`, key),
    );
    return null;
  }
  return t;
}

/**
 * 도메인분류 일괄 등록(§9.4: 접미어* · 명칭* · 타입* · 길이 · 스케일 · 설명). 키 = 접미어. 길이·스케일은 타입과 한 묶음이라
 * 빈 칸도 그대로(NULL) 반영한다(설명만 빈 칸 = 유지). 갱신하면 검토 표시(review_yn)를 해제한다.
 * 도메인 타입은 바꾸지 않는다 — 적용 후 [재계산](§4.8).
 */
export const domainClassesEngine: KindEngine<State, Op> = {
  kind: 'domain-classes',
  entityType: 'DOMAIN_CLS',
  title: '도메인분류',
  columns: [
    { key: 'suffix', label: '접미어', required: true },
    { key: 'clsNm', label: '명칭', required: true },
    { key: 'colType', label: '타입', required: true },
    { key: 'colLength', label: '길이', required: false },
    { key: 'colScale', label: '스케일', required: false },
    { key: 'description', label: '설명', required: false },
  ],
  computed: [{ key: 'typeText', label: '결과 타입' }],
  example: ['MEMO', '메모', 'VARCHAR', 500, null, '자유 입력 메모'],
  notes: [
    '타입은 VARCHAR, CHAR, TEXT, SMALLINT, INT, BIGINT, NUMERIC, DATE, TIMESTAMP, BOOLEAN, JSONB, BYTEA 중 하나입니다.',
    'VARCHAR·CHAR·NUMERIC은 길이가 필요하고, 스케일은 NUMERIC만 씁니다. 적용 후 도메인 화면에서 [재계산]하면 도메인 타입에 반영됩니다.',
  ],

  async load(q, projectId) {
    const rows = await q.select().from(stdDomainCls).where(eq(stdDomainCls.projectId, projectId));
    return { bySuffix: new Map(rows.map((r) => [r.suffix, r])) };
  },

  plan(rows, state): Planned<Op>[] {
    const keys = new FileKeys();
    return rows.map((r) => {
      const errors: ImportIssue[] = [];
      const suffix = normalizeAbbr(r.cells['suffix']);
      const clsNm = reqText(r.cells, 'clsNm', '명칭', 500, errors);
      const colType = typeCell(r.cells, 'colType', '타입', errors, true);
      const colLength = intCell(r.cells, 'colLength', '길이', 0, 1_000_000, errors);
      const colScale = intCell(r.cells, 'colScale', '스케일', 0, 1_000, errors);
      const description = optText(r.cells, 'description', '설명', 200, errors);
      if (colType) {
        for (const e of validateDomainCls({ suffix, colType, colLength, colScale }))
          errors.push(issue(e.code, e.message, e.field));
      } else {
        for (const e of validateDomainCls({
          suffix,
          colType: 'TEXT',
          colLength: null,
          colScale: null,
        }))
          errors.push(issue(e.code, e.message, e.field));
      }
      if (suffix) keys.claim(suffix, r.rowNo, errors, '접미어');
      const existing = suffix ? (state.bySuffix.get(suffix) ?? null) : null;
      const changes: Record<string, [unknown, unknown]> = {};
      if (existing && colType) {
        diff(changes, 'clsNm', existing.clsNm, clsNm);
        diff(changes, 'colType', existing.colType, colType);
        diff(changes, 'colLength', existing.colLength, colLength);
        diff(changes, 'colScale', existing.colScale, colScale);
        diff(changes, 'description', existing.description, description ?? undefined);
        if (existing.reviewYn) changes['reviewYn'] = [true, false];
      }
      const values = {
        suffix: suffix ?? '',
        clsNm,
        colType: colType ?? 'TEXT',
        colLength,
        colScale,
        description: description ?? existing?.description ?? null,
      };
      return finish(
        {
          rowNo: r.rowNo,
          key: suffix ?? '',
          values: { ...values, colType, typeText: typeText(colType, colLength, colScale) },
          changes,
          errors,
          warnings: [],
        },
        existing === null,
        { existing, values },
      );
    });
  },

  async apply(tx, projectId, rows, _state, a, batchId) {
    const ops = rows.flatMap((p) => (p.op ? [p.op] : []));
    const inserts = ops.filter((o) => o.existing === null);
    const updates = ops.filter((o) => o.existing !== null);
    for (const part of chunks(inserts, 500)) {
      const created = await insertAudited(
        tx,
        stdDomainCls,
        part.map((o) => ({ projectId, ...o.values })),
        a,
      ).returning();
      await writeStdAudit(
        tx,
        created.map((r) => ({
          projectId,
          entityType: 'DOMAIN_CLS' as const,
          entityId: r.domainClsId,
          action: 'IMPORT' as const,
          after: auditJson(r),
          batchId,
        })),
        a,
      );
    }
    for (const part of chunks(updates, 1000)) {
      await tx.execute(
        sql`update std_domain_cls c
               set cls_nm = u.nm, col_type = u.t, col_length = u.l, col_scale = u.s, description = u.d,
                   review_yn = false,
                   updated_at = CURRENT_TIMESTAMP, updated_by = ${a.actor}, updated_ip = ${a.ip}
              from unnest(${sql.param(part.map((o) => o.existing!.domainClsId))}::int[],
                          ${sql.param(part.map((o) => o.values.clsNm))}::text[],
                          ${sql.param(part.map((o) => o.values.colType))}::text[],
                          ${sql.param(part.map((o) => o.values.colLength))}::int[],
                          ${sql.param(part.map((o) => o.values.colScale))}::int[],
                          ${sql.param(part.map((o) => o.values.description))}::text[]) as u(id, nm, t, l, s, d)
             where c.domain_cls_id = u.id and c.project_id = ${projectId}`,
      );
      await writeStdAudit(
        tx,
        part.map((o) => {
          const before = auditJson(o.existing) as Record<string, unknown>;
          return {
            projectId,
            entityType: 'DOMAIN_CLS' as const,
            entityId: o.existing!.domainClsId,
            action: 'IMPORT' as const,
            before,
            after: { ...before, ...o.values, reviewYn: false },
            batchId,
          };
        }),
        a,
      );
    }
    return { new: inserts.length, update: updates.length };
  },
};
