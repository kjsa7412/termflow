import { count, eq } from 'drizzle-orm';
import { loadL1Snapshot } from '../../autocomplete/l1-snapshot.js';
import { MIGRATION_AUDIT } from '../../common/audit/audit.js';
import { insertMigrated } from '../../db/audit.js';
import { stdDomain } from '../../db/schema.js';
import { StepFailure, stdv1Has, stdv1Id, type StepDef } from '../context.js';
import { readDomains } from '../legacy-reader.js';
import { decideDomain, type DomainReport } from '../rules/r05-r15-domain.js';
import { migratedTimes } from '../rules/r13-audit.js';

export { loadL1Snapshot };

/** step 6 DOMAIN(T3.10): R1·R5(+R5-b)·R9·R12·R13·R15 → STDV1 `std_domain`. */
export const domainStep: StepDef = {
  name: 'DOMAIN',
  isDone: ({ db }) =>
    stdv1Has(db, async (id) => {
      const [r] = await db
        .select({ n: count() })
        .from(stdDomain)
        .where(eq(stdDomain.projectId, id));
      return r?.n ?? 0;
    }),
  async run({ tx, report }) {
    const projectId = await stdv1Id(tx);
    const snap = await loadL1Snapshot(tx, projectId);
    if (snap.termByKor.size === 0 || snap.clsBySuffix.size === 0) {
      throw new StepFailure(
        'STDV1 용어·도메인분류가 비어 있습니다 — TERM·DOMAIN_CLS step을 먼저 실행하십시오',
      );
    }
    const legacy = await readDomains(tx);
    for (const f of [
      'r05_domain_type',
      'r09_physical_normalized',
      'r15_domain_physical',
      'r15_unregistered_parts',
    ]) {
      report.declare(f);
    }
    const pending: { logical: string; legacyKey: number; rep: DomainReport }[] = [];
    const unregistered: { logical: string; legacyKey: number; part: string }[] = [];
    const c = {
      r1: 0,
      r9: 0,
      r5Src: 0,
      r5Manual: 0,
      r5Recalc: 0,
      r5Review: 0,
      r5Override: 0,
      r15Src: 0,
      r15Recalc: 0,
      r15Review: 0,
      review: 0,
    };
    const seen = new Set<string>();

    const values = legacy.map((d) => {
      const dec = decideDomain(
        {
          domainId: d.domain_id,
          nm: [d.nm1, d.nm2, d.nm3, d.nm4, d.nm5, d.nm6, d.nm7],
          logicalNm: d.logical_nm,
          physicalNm: d.physical_nm,
          descr: d.descr,
          suffix: d.suffix,
          colType: d.col_type,
          colLength: d.col_length,
          colTypeManual: d.col_type_manual,
        },
        snap,
      );
      const t = dec.target;
      if (seen.has(t.logicalNm)) throw new StepFailure(`도메인 논리명 중복: ${t.logicalNm}`);
      seen.add(t.logicalNm);
      if (t.nm[0] === null) throw new StepFailure(`nm1이 비어 있는 도메인: ${d.domain_id}`);
      for (const rep of dec.reports) {
        pending.push({ logical: t.logicalNm, legacyKey: d.domain_id, rep });
        if (rep.rule === 'R01') c.r1++;
        if (rep.rule === 'R09') c.r9++;
      }
      for (const part of dec.notFound)
        unregistered.push({ logical: t.logicalNm, legacyKey: d.domain_id, part });
      if (dec.r5 === 'MANUAL_OVERRIDE') c.r5Override++;
      else if (dec.r5 !== null) {
        c.r5Src++;
        if (dec.r5 === 'MANUAL') c.r5Manual++;
        else if (dec.r5 === 'RECALC') c.r5Recalc++;
        else c.r5Review++;
      }
      if (dec.r15 !== null) {
        c.r15Src++;
        if (dec.r15 === 'RECALC') c.r15Recalc++;
        else c.r15Review++;
      }
      if (t.reviewYn) c.review++;
      return {
        projectId,
        nm1: t.nm[0]!,
        nm2: t.nm[1] ?? null,
        nm3: t.nm[2] ?? null,
        nm4: t.nm[3] ?? null,
        nm5: t.nm[4] ?? null,
        nm6: t.nm[5] ?? null,
        nm7: t.nm[6] ?? null,
        logicalNm: t.logicalNm,
        physicalNm: t.physicalNm,
        descr: t.descr?.slice(0, 500) ?? null,
        suffix: t.suffix?.slice(0, 30) ?? null,
        domainClsId: t.domainClsId,
        colType: t.colType,
        colLength: t.colLength,
        colScale: t.colScale,
        typeSource: t.typeSource,
        reviewYn: t.reviewYn,
        reviewNote: t.reviewNote,
        ...migratedTimes(d.firs_reg_dts, d.fina_reg_dts),
      };
    });

    const inserted = await insertMigrated(tx, stdDomain, values, MIGRATION_AUDIT, (q) =>
      q.returning({ id: stdDomain.domainId, logical: stdDomain.logicalNm }),
    );
    const idByLogical = new Map(inserted.map((r) => [r.logical, r.id]));
    for (const p of pending) {
      report.add(p.rep.file, {
        rule: p.rep.rule,
        step: 'DOMAIN',
        legacyKey: p.legacyKey,
        targetTable: 'std_domain',
        targetId: idByLogical.get(p.logical) ?? null,
        field: p.rep.field,
        before: p.rep.before,
        after: p.rep.after,
        action: p.rep.action,
        note: p.rep.note ?? null,
      });
    }
    // 미등록 조각(용어 등록 후 recalculate 대상, §11.2 R15): 출현 1회 = 1행
    const partCount = new Map<string, number>();
    for (const u of unregistered) partCount.set(u.part, (partCount.get(u.part) ?? 0) + 1);
    for (const u of unregistered) {
      report.add('r15_unregistered_parts', {
        rule: 'R15',
        step: 'DOMAIN',
        legacyKey: u.legacyKey,
        targetTable: 'std_domain',
        targetId: idByLogical.get(u.logical) ?? null,
        field: 'part',
        before: u.part,
        after: null,
        action: 'REVIEW',
        note: `${u.logical} (조각 '${u.part}' 전체 ${partCount.get(u.part)}회)`,
      });
    }
    return {
      source: legacy.length,
      loaded: inserted.length,
      excluded: 0,
      flagged: c.review,
      rules: [
        { rule: 'R01', source: legacy.length, loaded: c.r1, excluded: 0, flagged: 0 },
        {
          rule: 'R05',
          source: c.r5Src,
          loaded: c.r5Manual + c.r5Recalc,
          excluded: 0,
          flagged: c.r5Review,
        },
        { rule: 'R05b', source: c.r5Override, loaded: c.r5Override, excluded: 0, flagged: 0 },
        { rule: 'R09', source: legacy.length, loaded: c.r9, excluded: 0, flagged: 0 },
        { rule: 'R15', source: c.r15Src, loaded: c.r15Recalc, excluded: 0, flagged: c.r15Review },
      ],
      message:
        `R5 타입 미정 ${c.r5Src}: MANUAL ${c.r5Manual} · RECALC ${c.r5Recalc} · REVIEW ${c.r5Review}; ` +
        `R5-b 수기 우선 ${c.r5Override}; R15 물리명 NULL ${c.r15Src}: 재생성 ${c.r15Recalc} · REVIEW ${c.r15Review}; ` +
        `미등록 조각 ${partCount.size}종 ${unregistered.length}회; review 합계 ${c.review}`,
    };
  },
};
