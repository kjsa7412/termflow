import { and, count, eq } from 'drizzle-orm';
import { MIGRATION_AUDIT } from '../../common/audit/audit.js';
import { insertMigrated } from '../../db/audit.js';
import { prjBizArea, stdCode, stdCodeCls } from '../../db/schema.js';
import { StepFailure, stdv1Has, stdv1Id, type StepDef } from '../context.js';
import { readCodes, type LegacyCode } from '../legacy-reader.js';
import { migratedTimes } from '../rules/r13-audit.js';

/**
 * step 7 CODE(T3.11, R7 ②·R13): distinct (biz_cls, code_cls, code_cls_nm) → `std_code_cls`(업무구분은 biz_cd로 연결),
 * 코드는 code_cls_id 조인 적재, sort_order = 코드구분 안 원본 순. 코드구분명이 2개 이상이면 실패.
 */
export const codeStep: StepDef = {
  name: 'CODE',
  isDone: ({ db }) =>
    stdv1Has(db, async (id) => {
      const [r] = await db
        .select({ n: count() })
        .from(stdCodeCls)
        .where(eq(stdCodeCls.projectId, id));
      return r?.n ?? 0;
    }),
  async run({ tx, report }) {
    const projectId = await stdv1Id(tx);
    const biz = await tx
      .select({ id: prjBizArea.bizAreaId, cd: prjBizArea.bizCd })
      .from(prjBizArea)
      .where(eq(prjBizArea.projectId, projectId));
    const bizId = new Map(biz.map((b) => [b.cd, b.id]));
    if (bizId.size === 0) {
      throw new StepFailure('STDV1 업무구분이 없습니다 — BIZ_AREA step을 먼저 실행하십시오');
    }

    const legacy = await readCodes(tx);
    const clsKey = (c: Pick<LegacyCode, 'biz_cls' | 'code_cls'>) =>
      `${c.biz_cls.trim()}|${c.code_cls.trim()}`;
    const classes = new Map<
      string,
      { biz: string; cls: string; names: Set<string>; first: LegacyCode; n: number }
    >();
    for (const c of legacy) {
      const k = clsKey(c);
      const e = classes.get(k) ?? {
        biz: c.biz_cls.trim(),
        cls: c.code_cls.trim(),
        names: new Set<string>(),
        first: c,
        n: 0,
      };
      e.names.add(c.code_cls_nm.trim());
      e.n++;
      classes.set(k, e);
    }
    const multi = [...classes.values()].filter((e) => e.names.size > 1);
    if (multi.length > 0) {
      throw new StepFailure(
        `코드구분명이 2개 이상인 코드구분(R7): ${multi.map((m) => `${m.biz}.${m.cls}`).join(', ')}`,
      );
    }
    const clsValues = [...classes.values()].map((e) => {
      const b = bizId.get(e.biz);
      if (b === undefined) throw new StepFailure(`업무구분 ${e.biz}가 STDV1에 없습니다`);
      return {
        projectId,
        bizAreaId: b,
        codeCls: e.cls,
        codeClsNm: [...e.names][0]!,
        ...migratedTimes(e.first.firs_reg_dts, e.first.fina_reg_dts),
      };
    });
    const insertedCls = await insertMigrated(tx, stdCodeCls, clsValues, MIGRATION_AUDIT, (q) =>
      q.returning({
        id: stdCodeCls.codeClsId,
        bizAreaId: stdCodeCls.bizAreaId,
        codeCls: stdCodeCls.codeCls,
      }),
    );
    const cdById = new Map(biz.map((b) => [b.id, b.cd]));
    const clsId = new Map(
      insertedCls.map((r) => [`${cdById.get(r.bizAreaId)}|${r.codeCls}`, r.id]),
    );
    for (const e of classes.values()) {
      report.add('r07_code_cls', {
        rule: 'R07',
        step: 'CODE',
        legacyKey: `${e.biz}.${e.cls}`,
        targetTable: 'std_code_cls',
        targetId: clsId.get(`${e.biz}|${e.cls}`) ?? null,
        field: 'code_cls',
        before: `${e.n}행`,
        after: [...e.names][0]!,
        action: 'NORMALIZED',
        note: `코드 ${e.n}건`,
      });
    }
    const codeValues = legacy.map((c) => ({
      projectId,
      codeClsId: clsId.get(clsKey(c))!,
      code: c.code.trim(),
      codeNm: c.code_nm.trim(),
      sortOrder: c.seq,
      isActive: true,
      ...migratedTimes(c.firs_reg_dts, c.fina_reg_dts),
    }));
    const insertedCodes = await insertMigrated(tx, stdCode, codeValues, MIGRATION_AUDIT, (q) =>
      q.returning({ id: stdCode.codeId }),
    );
    // DoD: 코드구분의 업무구분이 전부 STDV1 소속(복합 FK가 보장하지만 건수로도 확인)
    const [own] = await tx
      .select({ n: count() })
      .from(stdCodeCls)
      .innerJoin(
        prjBizArea,
        and(eq(prjBizArea.bizAreaId, stdCodeCls.bizAreaId), eq(prjBizArea.projectId, projectId)),
      )
      .where(eq(stdCodeCls.projectId, projectId));
    if ((own?.n ?? 0) !== insertedCls.length) {
      throw new StepFailure('STDV1 밖 업무구분을 참조하는 코드구분이 있습니다');
    }
    return {
      source: legacy.length,
      loaded: insertedCodes.length,
      excluded: 0,
      flagged: 0,
      rules: [
        { rule: 'R07', source: classes.size, loaded: insertedCls.length, excluded: 0, flagged: 0 },
      ],
      message: `코드구분 ${insertedCls.length} · 코드 ${insertedCodes.length}`,
    };
  },
};
