import { eq, sql } from 'drizzle-orm';
import type { ImportIssue } from '@termflow/shared';
import type { L1Snapshot } from '../../autocomplete/domain-calculator.js';
import { loadL1Snapshot } from '../../autocomplete/l1-snapshot.js';
import { insertAudited } from '../../db/audit.js';
import { stdDomain } from '../../db/schema.js';
import { planDomain, planFields } from '../domain-plan.js';
import { auditJson, writeStdAudit } from '../std-audit.js';
import { chunks } from '../std-sql.js';
import { typeCell } from './domain-classes.engine.js';
import { FileKeys, finish, intCell, issue, type KindEngine, type Planned } from './engine.js';

type DomainRow = typeof stdDomain.$inferSelect;
interface State {
  snap: L1Snapshot;
  byLogical: Map<string, DomainRow>;
}
type Fields = ReturnType<typeof planFields>;
interface Op {
  existing: DomainRow | null;
  fields: Fields;
}

const NM_KEYS = ['nm1', 'nm2', 'nm3', 'nm4', 'nm5', 'nm6', 'nm7'] as const;
/** 비교 대상 필드(감사 컬럼·출처 제외). */
const COMPARE: readonly (keyof Fields)[] = [
  ...NM_KEYS,
  'physicalNm',
  'descr',
  'suffix',
  'domainClsId',
  'colType',
  'colLength',
  'colScale',
  'typeSource',
  'reviewYn',
  'reviewNote',
];

/**
 * 도메인 일괄 등록(§9.4: 명칭1* · 명칭2~7 · 수기타입 · 수기길이 · 수기스케일). 논리명·물리명·타입은 L1으로 계산해 미리보기에
 * 보여 주고(계산 열), 키 = 계산 논리명. 수기타입이 있으면 MANUAL. 조각이 같고 기존 물리명이 있으면 물리명 유지(도메인 수정 API와 같은 규칙).
 * 정정 흐름(T6.14): 용어 xlsx를 먼저 적용한 뒤 도메인 xlsx를 올리면 새 용어로 계산된다.
 */
export const domainsEngine: KindEngine<State, Op> = {
  kind: 'domains',
  entityType: 'DOMAIN',
  title: '도메인',
  columns: [
    { key: 'nm1', label: '명칭1', required: true },
    { key: 'nm2', label: '명칭2', required: false },
    { key: 'nm3', label: '명칭3', required: false },
    { key: 'nm4', label: '명칭4', required: false },
    { key: 'nm5', label: '명칭5', required: false },
    { key: 'nm6', label: '명칭6', required: false },
    { key: 'nm7', label: '명칭7', required: false },
    { key: 'manualType', label: '수기타입', required: false },
    { key: 'manualLength', label: '수기길이', required: false },
    { key: 'manualScale', label: '수기스케일', required: false },
  ],
  computed: [
    { key: 'logicalNm', label: '논리명' },
    { key: 'physicalNm', label: '물리명' },
    { key: 'typeText', label: '타입' },
  ],
  example: ['가격', '인하', '금액', null, null, null, null, null, null, null],
  notes: [
    '명칭 조각을 순서대로 입력하면 논리명·물리명·접미어·타입이 자동 계산됩니다(L1). 숫자 조각 0~10은 _ 없이 붙습니다.',
    '수기타입(예: VARCHAR)을 쓰면 접미어 규칙 대신 그 타입을 씁니다(수기길이·수기스케일과 함께).',
    '미등록 조각이 있으면 물리명 없이 검토필요로 등록됩니다 — 용어를 먼저 등록하세요.',
  ],

  async load(q, projectId) {
    const snap = await loadL1Snapshot(q, projectId);
    const rows = await q.select().from(stdDomain).where(eq(stdDomain.projectId, projectId));
    return { snap, byLogical: new Map(rows.map((r) => [r.logicalNm, r])) };
  },

  plan(rows, state): Planned<Op>[] {
    const keys = new FileKeys();
    return rows.map((r) => {
      const errors: ImportIssue[] = [];
      for (const k of NM_KEYS) {
        const v = r.cells[k];
        if (v && v.length > 100) errors.push(issue('E_LENGTH', `${k}은(는) 100자 이내입니다`, k));
      }
      const manualType = typeCell(r.cells, 'manualType', '수기타입', errors, false);
      const manualLength = intCell(r.cells, 'manualLength', '수기길이', 0, 1_000_000, errors);
      const manualScale = intCell(r.cells, 'manualScale', '수기스케일', 0, 1_000, errors);
      const plan = planDomain(
        {
          nm: NM_KEYS.map((k) => r.cells[k] ?? null),
          typeSource: manualType ? 'MANUAL' : 'AUTO',
          colType: manualType,
          colLength: manualType ? manualLength : null,
          colScale: manualType ? manualScale : null,
        },
        state.snap,
      );
      for (const e of plan.errors) errors.push(issue(e.code, e.message, e.field));
      if (plan.logicalNm !== '') keys.claim(plan.logicalNm, r.rowNo, errors, '논리명');
      const existing = state.byLogical.get(plan.logicalNm) ?? null;
      const fields = planFields(plan);
      const changes: Record<string, [unknown, unknown]> = {};
      if (existing) {
        const sameParts = NM_KEYS.every((k) => (existing[k] ?? null) === (fields[k] ?? null));
        if (
          sameParts &&
          existing.physicalNm !== null &&
          fields.physicalNm !== existing.physicalNm
        ) {
          fields.physicalNm = existing.physicalNm;
          fields.descr = existing.descr ?? fields.descr;
          const rest = plan.reviewReasons.filter(
            (x) => !x.startsWith('미등록 조각') && !x.startsWith('물리명'),
          );
          fields.reviewYn = rest.length > 0;
          fields.reviewNote = rest.length > 0 ? rest.join('; ') : null;
        }
        for (const k of COMPARE) {
          const b = existing[k as keyof DomainRow] ?? null;
          const n = fields[k] ?? null;
          if (b !== n) changes[k] = [b, n];
        }
      }
      return finish(
        {
          rowNo: r.rowNo,
          key: plan.logicalNm,
          values: {
            ...Object.fromEntries(NM_KEYS.map((k) => [k, r.cells[k] ?? null])),
            manualType,
            manualLength,
            manualScale,
            logicalNm: plan.logicalNm,
            physicalNm: fields.physicalNm,
            typeText: plan.typeText,
          },
          changes,
          errors,
          warnings: plan.warnings.map((w) => issue(w.code, w.message, w.field)),
        },
        existing === null,
        { existing, fields },
      );
    });
  },

  async apply(tx, projectId, rows, _state, a, batchId) {
    const ops = rows.flatMap((p) => (p.op ? [p.op] : []));
    const inserts = ops.filter((o) => o.existing === null);
    const updates = ops.filter((o) => o.existing !== null);
    for (const part of chunks(inserts, 300)) {
      const created = await insertAudited(
        tx,
        stdDomain,
        part.map((o) => ({ projectId, ...o.fields })),
        a,
      ).returning();
      await writeStdAudit(
        tx,
        created.map((r) => ({
          projectId,
          entityType: 'DOMAIN' as const,
          entityId: r.domainId,
          action: 'IMPORT' as const,
          after: auditJson(r),
          batchId,
        })),
        a,
      );
    }
    for (const part of chunks(updates, 1000)) {
      const col = <K extends keyof Fields>(k: K) => sql.param(part.map((o) => o.fields[k]));
      await tx.execute(
        sql`update std_domain d
               set nm1 = u.nm1, nm2 = u.nm2, nm3 = u.nm3, nm4 = u.nm4, nm5 = u.nm5, nm6 = u.nm6, nm7 = u.nm7,
                   physical_nm = u.physical_nm, descr = u.descr, suffix = u.suffix, domain_cls_id = u.domain_cls_id,
                   col_type = u.col_type, col_length = u.col_length, col_scale = u.col_scale,
                   type_source = u.type_source, review_yn = u.review_yn, review_note = u.review_note,
                   updated_at = CURRENT_TIMESTAMP, updated_by = ${a.actor}, updated_ip = ${a.ip}
              from unnest(${sql.param(part.map((o) => o.existing!.domainId))}::int[],
                          ${col('nm1')}::text[], ${col('nm2')}::text[], ${col('nm3')}::text[], ${col('nm4')}::text[],
                          ${col('nm5')}::text[], ${col('nm6')}::text[], ${col('nm7')}::text[],
                          ${col('physicalNm')}::text[], ${col('descr')}::text[], ${col('suffix')}::text[],
                          ${col('domainClsId')}::int[], ${col('colType')}::text[], ${col('colLength')}::int[],
                          ${col('colScale')}::int[], ${col('typeSource')}::text[], ${col('reviewYn')}::boolean[],
                          ${col('reviewNote')}::text[])
                   as u(id, nm1, nm2, nm3, nm4, nm5, nm6, nm7, physical_nm, descr, suffix, domain_cls_id, col_type,
                        col_length, col_scale, type_source, review_yn, review_note)
             where d.domain_id = u.id and d.project_id = ${projectId}`,
      );
      await writeStdAudit(
        tx,
        part.map((o) => {
          const before = auditJson(o.existing) as Record<string, unknown>;
          return {
            projectId,
            entityType: 'DOMAIN' as const,
            entityId: o.existing!.domainId,
            action: 'IMPORT' as const,
            before,
            after: { ...before, ...o.fields },
            batchId,
          };
        }),
        a,
      );
    }
    return { new: inserts.length, update: updates.length };
  },
};
