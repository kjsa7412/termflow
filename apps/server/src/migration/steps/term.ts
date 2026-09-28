import { count, eq } from 'drizzle-orm';
import { MIGRATION_AUDIT } from '../../common/audit/audit.js';
import { insertMigrated } from '../../db/audit.js';
import { stdTerm } from '../../db/schema.js';
import { StepFailure, stdv1Has, stdv1Id, type StepDef } from '../context.js';
import { readTerms } from '../legacy-reader.js';
import type { ReportRow } from '../report-writer.js';
import { isNumericDotZero, normalizeNumericText } from '../rules/r01-numeric-terms.js';
import { shouldNullDescription } from '../rules/r02-description.js';
import { decideSynonymRef } from '../rules/r04-synonym.js';
import { decideTermPhysical, synonymGroups } from '../rules/r08-physical.js';
import { migratedTimes } from '../rules/r13-audit.js';

type Pending = {
  file: string;
  termKor: string;
  row: Omit<ReportRow, 'targetId' | 'step' | 'targetTable'>;
};

/** step 5 TERM(T3.9): R1·R2·R4·R8·R13 → STDV1 `std_term`(전부 APPROVED). */
export const termStep: StepDef = {
  name: 'TERM',
  isDone: ({ db }) =>
    stdv1Has(db, async (id) => {
      const [r] = await db.select({ n: count() }).from(stdTerm).where(eq(stdTerm.projectId, id));
      return r?.n ?? 0;
    }),
  async run({ tx, report }) {
    const projectId = await stdv1Id(tx);
    const legacy = await readTerms(tx);
    for (const f of [
      'r01_numeric_terms',
      'r02_description_null',
      'r04_synonym_candidates',
      'r08_physical_format',
      'r08_synonym_groups',
    ]) {
      report.declare(f);
    }
    const pending: Pending[] = [];
    const c = { r1: 0, r2: 0, r4Nulled: 0, r4Kept: 0, r8Norm: 0, r8Review: 0, r8Filled: 0 };
    const seen = new Set<string>();

    const values = legacy.map((t) => {
      const key = String(t.term_id);
      // R1
      let termKor = t.term_kor.trim();
      if (isNumericDotZero(termKor)) {
        const after = normalizeNumericText(termKor);
        pending.push({
          file: 'r01_numeric_terms',
          termKor: after,
          row: {
            rule: 'R01',
            legacyKey: key,
            field: 'term_kor',
            before: termKor,
            after,
            action: 'NORMALIZED',
          },
        });
        termKor = after;
        c.r1++;
      }
      if (seen.has(termKor)) throw new StepFailure(`R1 정규화 후 용어 중복: ${termKor}`);
      seen.add(termKor);
      let physicalIn = t.term_physical;
      if (physicalIn !== null && isNumericDotZero(physicalIn)) {
        const after = normalizeNumericText(physicalIn);
        pending.push({
          file: 'r01_numeric_terms',
          termKor,
          row: {
            rule: 'R01',
            legacyKey: key,
            field: 'term_physical',
            before: physicalIn,
            after,
            action: 'NORMALIZED',
          },
        });
        physicalIn = after;
      }
      // R2
      let description = t.description;
      if (shouldNullDescription(description, termKor)) {
        pending.push({
          file: 'r02_description_null',
          termKor,
          row: {
            rule: 'R02',
            legacyKey: key,
            field: 'description',
            before: description,
            after: null,
            action: 'NULLED',
            note:
              description!.length <= 1
                ? '1자 이하'
                : description === termKor
                  ? '용어와 동일'
                  : '공백',
          },
        });
        description = null;
        c.r2++;
      }
      // R4
      const syn = decideSynonymRef(t.same_nm_ref);
      if (syn.kind === 'NULLED') {
        pending.push({
          file: 'r04_synonym_candidates',
          termKor,
          row: {
            rule: 'R04',
            legacyKey: key,
            field: 'synonym_ref',
            before: syn.before,
            after: null,
            action: 'NULLED',
            note: '숫자 참조',
          },
        });
        c.r4Nulled++;
      } else if (syn.kind === 'KEPT') {
        pending.push({
          file: 'r04_synonym_candidates',
          termKor,
          row: {
            rule: 'R04',
            legacyKey: key,
            field: 'synonym_ref',
            before: t.same_nm_ref,
            after: syn.value,
            action: 'NORMALIZED',
            note: '보존(2차 동의어 관리 입력)',
          },
        });
        c.r4Kept++;
      }
      // R8
      const ph = decideTermPhysical(physicalIn, termKor);
      let termPhysical: string | null = null;
      let reviewYn = false;
      let reviewNote: string | null = null;
      if (ph.kind === 'KEEP') termPhysical = ph.value;
      else if (ph.kind === 'NORMALIZED' || ph.kind === 'FILLED_NUMERIC') {
        termPhysical = ph.value;
        pending.push({
          file: 'r08_physical_format',
          termKor,
          row: {
            rule: 'R08',
            legacyKey: key,
            field: 'term_physical',
            before: t.term_physical,
            after: ph.value,
            action: 'NORMALIZED',
            note: ph.kind === 'FILLED_NUMERIC' ? '숫자 용어 → term_kor' : 'upper(trim)',
          },
        });
        if (ph.kind === 'NORMALIZED') c.r8Norm++;
        else c.r8Filled++;
      } else {
        reviewYn = true;
        reviewNote = ph.note;
        pending.push({
          file: 'r08_physical_format',
          termKor,
          row: {
            rule: 'R08',
            legacyKey: key,
            field: 'term_physical',
            before: t.term_physical,
            after: null,
            action: 'REVIEW',
            note: ph.note,
          },
        });
        c.r8Review++;
      }
      return {
        projectId,
        termKor,
        termPhysical,
        description: description?.slice(0, 500) ?? null,
        synonymRef: syn.kind === 'KEPT' ? syn.value.slice(0, 200) : null,
        status: 'APPROVED',
        reviewYn,
        reviewNote,
        ...migratedTimes(t.firs_reg_dts, t.fina_reg_dts),
      };
    });

    const inserted = await insertMigrated(tx, stdTerm, values, MIGRATION_AUDIT, (q) =>
      q.returning({ id: stdTerm.termId, kor: stdTerm.termKor }),
    );
    const idByKor = new Map(inserted.map((r) => [r.kor, r.id]));
    for (const p of pending) {
      report.add(p.file, {
        ...p.row,
        step: 'TERM',
        targetTable: 'std_term',
        targetId: idByKor.get(p.termKor) ?? null,
      });
    }
    // R8 동의어 후보 그룹(정보): 같은 물리약어를 공유하는 용어
    const groups = synonymGroups(
      values.map((v) => ({ termKor: v.termKor, physical: v.termPhysical })),
    );
    for (const g of groups) {
      report.add('r08_synonym_groups', {
        rule: 'R08',
        step: 'TERM',
        legacyKey: g.physical,
        targetTable: 'std_term',
        targetId: g.terms.map((k) => idByKor.get(k)).join('/'),
        field: 'term_physical',
        before: g.terms.join('/'),
        after: g.physical,
        action: 'REVIEW',
        note: `정보: 동의어 후보 ${g.terms.length}건`,
      });
    }
    const flagged = c.r8Review;
    return {
      source: legacy.length,
      loaded: inserted.length,
      excluded: 0,
      flagged,
      rules: [
        { rule: 'R01', source: legacy.length, loaded: c.r1, excluded: 0, flagged: 0 },
        { rule: 'R02', source: legacy.length, loaded: c.r2, excluded: 0, flagged: 0 },
        { rule: 'R04', source: c.r4Nulled + c.r4Kept, loaded: c.r4Kept, excluded: 0, flagged: 0 },
        {
          rule: 'R08',
          source: legacy.length,
          loaded: c.r8Norm + c.r8Filled,
          excluded: 0,
          flagged: c.r8Review,
        },
      ],
      message:
        `R1 ${c.r1} · R2 NULL ${c.r2} · R4 NULL ${c.r4Nulled}/보존 ${c.r4Kept} · ` +
        `R8 대문자 ${c.r8Norm}/숫자 채움 ${c.r8Filled}/NULL+검토 ${c.r8Review} · 동의어 그룹 ${groups.length}`,
    };
  },
};
