import { count, eq } from 'drizzle-orm';
import { MIGRATION_AUDIT } from '../../common/audit/audit.js';
import { insertMigrated } from '../../db/audit.js';
import { stdDomainCls } from '../../db/schema.js';
import { StepFailure, templateHas, templateId, type StepDef } from '../context.js';
import { readDomainCls } from '../legacy-reader.js';
import type { ReportRow } from '../report-writer.js';
import { convertDomainClsType } from '../rules/r03-domain-cls-length.js';
import { NEW_SUFFIXES } from '../rules/new-suffixes.js';
import { migratedTimes } from '../rules/r13-audit.js';

/**
 * step 4 DOMAIN_CLS(T3.8): legacy 54(R3 길이 정수화·precision/scale·TIMESTAMP(n), R12 remark → description, R13)
 * + 신규 접미어 30(§11.6 D12) = 84.
 */
export const domainClsStep: StepDef = {
  name: 'DOMAIN_CLS',
  isDone: ({ db }) =>
    templateHas(db, async (id) => {
      const [r] = await db
        .select({ n: count() })
        .from(stdDomainCls)
        .where(eq(stdDomainCls.projectId, id));
      return r?.n ?? 0;
    }),
  async run({ tx, report }) {
    const projectId = await templateId(tx);
    const legacy = await readDomainCls(tx);
    report.declare('r03_domain_cls_length');
    const pending: { suffix: string; row: Omit<ReportRow, 'targetId'> }[] = [];
    const legacySuffixes = new Set<string>();
    let reviewLegacy = 0;
    const values = legacy.map((c) => {
      const suffix = c.suffix.trim().toUpperCase();
      legacySuffixes.add(suffix);
      const t = convertDomainClsType(c.col_type, c.col_length);
      if (t.review) reviewLegacy++;
      if (t.change) {
        pending.push({
          suffix,
          row: {
            rule: 'R03',
            step: 'DOMAIN_CLS',
            legacyKey: c.suffix,
            targetTable: 'std_domain_cls',
            field: t.change.field,
            before: t.change.before,
            after: t.change.after,
            action: t.review ? 'REVIEW' : 'NORMALIZED',
            note: t.reviewNote,
          },
        });
      }
      return {
        projectId,
        suffix,
        clsNm: c.cls_nm.trim(),
        colType: t.colType,
        colLength: t.colLength,
        colScale: t.colScale,
        description: c.remark?.trim() ? c.remark.trim().slice(0, 200) : null,
        reviewYn: t.review,
        ...migratedTimes(c.firs_reg_dts, c.fina_reg_dts),
      };
    });
    const dupNew = NEW_SUFFIXES.filter((n) => legacySuffixes.has(n.suffix));
    if (dupNew.length > 0) {
      throw new StepFailure(
        `신규 접미어가 원본에 이미 있습니다: ${dupNew.map((d) => d.suffix).join(', ')}`,
      );
    }
    const added = NEW_SUFFIXES.map((n) => ({
      projectId,
      suffix: n.suffix,
      clsNm: n.clsNm,
      colType: n.colType,
      colLength: n.colLength,
      colScale: n.colScale,
      description: `신규 접미어(§11.6 D12): ${n.note}`.slice(0, 200),
      reviewYn: n.review,
    }));
    const inserted = await insertMigrated(
      tx,
      stdDomainCls,
      [...values, ...added],
      MIGRATION_AUDIT,
      (q) => q.returning({ id: stdDomainCls.domainClsId, suffix: stdDomainCls.suffix }),
    );
    const idBySuffix = new Map(inserted.map((r) => [r.suffix, r.id]));
    for (const p of pending) {
      report.add('r03_domain_cls_length', { ...p.row, targetId: idBySuffix.get(p.suffix) ?? null });
    }
    const reviewNew = NEW_SUFFIXES.filter((n) => n.review).length;
    const r3 = report.count('r03_domain_cls_length');
    return {
      source: legacy.length,
      loaded: inserted.length,
      excluded: 0,
      flagged: reviewLegacy + reviewNew,
      rules: [
        { rule: 'R03', source: legacy.length, loaded: r3, excluded: 0, flagged: reviewLegacy },
        {
          rule: 'D12',
          source: NEW_SUFFIXES.length,
          loaded: added.length,
          excluded: 0,
          flagged: reviewNew,
        },
      ],
      message: `원본 ${legacy.length} + 신규 접미어 ${added.length} = ${inserted.length}(검토 표시 신규 ${reviewNew})`,
    };
  },
};
