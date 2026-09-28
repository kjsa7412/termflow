import { count, eq, sql } from 'drizzle-orm';
import { MIGRATION_AUDIT } from '../../common/audit/audit.js';
import { insertAudited } from '../../db/audit.js';
import { prjBizArea } from '../../db/schema.js';
import { StepFailure, stdv1Has, stdv1Id, type StepDef } from '../context.js';

/**
 * step 3 BIZ_AREA(T3.7, R7 ①): legacy.tb_code_info의 distinct (biz_cls, biz_cls_nm) → STDV1 `prj_biz_area`.
 * 접두어 = biz_cd || '_', 정렬 = 코드 순. 같은 biz_cls에 이름이 2개 이상이면 실패.
 */
export const bizAreaStep: StepDef = {
  name: 'BIZ_AREA',
  isDone: ({ db }) =>
    stdv1Has(db, async (id) => {
      const [r] = await db.select({ n: count() }).from(prjBizArea).where(eq(prjBizArea.projectId, id));
      return r?.n ?? 0;
    }),
  async run({ tx, report }) {
    const projectId = await stdv1Id(tx);
    const r = await tx.execute(
      sql`select biz_cls, biz_cls_nm, count(*)::int as n from legacy.tb_code_info group by 1, 2 order by 1, 2`,
    );
    const rows = r.rows as { biz_cls: string; biz_cls_nm: string; n: number }[];
    const dup = rows.filter((x, i) => rows.findIndex((y) => y.biz_cls === x.biz_cls) !== i);
    if (dup.length > 0) {
      throw new StepFailure(`업무구분명이 2개 이상인 업무구분: ${dup.map((d) => d.biz_cls).join(', ')}`);
    }
    const inserted = await insertAudited(
      tx,
      prjBizArea,
      rows.map((x, i) => ({
        projectId,
        bizCd: x.biz_cls.trim().toUpperCase(),
        bizNm: x.biz_cls_nm.trim(),
        tablePrefix: `${x.biz_cls.trim().toUpperCase()}_`,
        sortNo: i + 1,
      })),
      MIGRATION_AUDIT,
    ).returning({ id: prjBizArea.bizAreaId, cd: prjBizArea.bizCd });
    for (const [i, x] of rows.entries()) {
      report.add('r07_code_cls', {
        rule: 'R07', step: 'BIZ_AREA', legacyKey: x.biz_cls, targetTable: 'prj_biz_area',
        targetId: inserted[i]!.id, field: 'biz_cd', before: `${x.biz_cls} ${x.biz_cls_nm}(코드 ${x.n}행)`,
        after: `${x.biz_cls}(${x.biz_cls}_)`, action: 'NORMALIZED', note: '업무구분 정규화(R7 ①)',
      });
    }
    return {
      source: rows.length,
      loaded: inserted.length,
      excluded: 0,
      flagged: 0,
      rules: [{ rule: 'R07', source: rows.length, loaded: inserted.length, excluded: 0, flagged: 0 }],
      message: `업무구분 ${inserted.map((b) => b.cd).join('·')}`,
    };
  },
};
