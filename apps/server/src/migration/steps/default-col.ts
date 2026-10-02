import { count, eq } from 'drizzle-orm';
import { MIGRATION_AUDIT } from '../../common/audit/audit.js';
import { insertAudited, insertMigrated, updateAudited } from '../../db/audit.js';
import { stdDefaultCol, stdDefaultColSet, tfProject } from '../../db/schema.js';
import { parseStdType } from '../../standard/std-type-parser.js';
import { SEED_TEMPLATE, StepFailure, templateHas, templateId, type StepDef } from '../context.js';
import { readDefaultCols } from '../legacy-reader.js';
import { normalizePhysicalName } from '../rules/r09-physical-name.js';
import { migratedTimes } from '../rules/r13-audit.js';
import { r19ColumnName, R19_REPORT, R19_RULE } from '../rules/r19-term-unify.js';

export const DEFAULT_SET_NM = '기본';

/**
 * step 8 DEFAULT_COL(T3.12, R14·R16): RETAILV1 세트 '기본'(is_default) + 9행
 * (R16 3분할, 기본값 `CURRENT_TIMESTAMP` 보존), `tf_project.default_col_set_id` 지정.
 */
export const defaultColStep: StepDef = {
  name: 'DEFAULT_COL',
  isDone: ({ db }) =>
    templateHas(db, async (id) => {
      const [r] = await db
        .select({ n: count() })
        .from(stdDefaultColSet)
        .where(eq(stdDefaultColSet.projectId, id));
      return r?.n ?? 0;
    }),
  async run({ tx, report }) {
    const projectId = await templateId(tx);
    const legacy = await readDefaultCols(tx);
    report.declare('r14_default_cols');
    report.declare('r16_type_parse');
    report.declare(R19_REPORT);
    let r19 = 0;
    const [set] = await insertAudited(
      tx,
      stdDefaultColSet,
      {
        projectId,
        setNm: DEFAULT_SET_NM,
        description: '승계 기본컬럼(tb_default_col 9행, R14)',
        isDefault: true,
      },
      MIGRATION_AUDIT,
    ).returning({ id: stdDefaultColSet.setId });
    const setId = set!.id;
    const values = legacy.map((c) => {
      const t = parseStdType(c.data_type);
      if (!t.ok) {
        throw new StepFailure(
          `R16 기본컬럼 타입 해석 불가: ${c.physical_col_nm} ${c.data_type} (${t.reason})`,
        );
      }
      report.add('r16_type_parse', {
        rule: 'R16',
        step: 'DEFAULT_COL',
        legacyKey: c.col_seq,
        targetTable: 'std_default_col',
        targetId: null,
        field: 'data_type',
        before: c.data_type,
        after: `${t.type}|${t.length ?? ''}|${t.scale ?? ''}`,
        action: 'NORMALIZED',
      });
      const phys = normalizePhysicalName(c.physical_col_nm, /^[A-Z][A-Z0-9_]*$/);
      if (phys.formatError || phys.value === null) {
        throw new StepFailure(`기본컬럼 물리명 형식 위반: ${c.physical_col_nm}`);
      }
      // R19(CR-09): 등록자 = RGSRT — FIRS/FINA_REG_USER_ID → FIRS/FINA_RGSRT_ID
      const physicalNm = r19ColumnName(phys.value);
      if (physicalNm !== phys.value) {
        r19++;
        report.add(R19_REPORT, {
          rule: R19_RULE,
          step: 'DEFAULT_COL',
          legacyKey: c.col_seq,
          targetTable: 'std_default_col',
          targetId: null,
          field: 'physical_nm',
          before: phys.value,
          after: physicalNm,
          action: 'NORMALIZED',
          note: `${SEED_TEMPLATE.key} 세트 ${DEFAULT_SET_NM}: ${c.logical_col_nm.trim()}`,
        });
      }
      const isPk = (c.is_key ?? 'N').trim().toUpperCase() === 'Y';
      return {
        projectId,
        setId,
        colSeq: c.col_seq,
        logicalNm: c.logical_col_nm.trim(),
        physicalNm,
        isPk,
        dataType: t.type,
        dataLength: t.length,
        dataScale: t.scale,
        isNullable: isPk ? false : (c.is_nullable ?? 'Y').trim().toUpperCase() === 'Y',
        defaultVal: c.default_val?.trim() ? c.default_val.trim() : null,
        colComment: c.col_comment?.trim() ? c.col_comment.trim() : null,
        ...migratedTimes(c.firs_reg_dts, c.fina_reg_dts),
      };
    });
    const inserted = await insertMigrated(tx, stdDefaultCol, values, MIGRATION_AUDIT, (q) =>
      q.returning({
        id: stdDefaultCol.defaultColId,
        seq: stdDefaultCol.colSeq,
        phys: stdDefaultCol.physicalNm,
      }),
    );
    for (const r of inserted) {
      const v = values.find((x) => x.colSeq === r.seq)!;
      report.add('r14_default_cols', {
        rule: 'R14',
        step: 'DEFAULT_COL',
        legacyKey: r.seq,
        targetTable: 'std_default_col',
        targetId: r.id,
        field: 'physical_nm',
        before: r.phys,
        after: `세트 ${DEFAULT_SET_NM}(${setId})`,
        action: 'NORMALIZED',
        note: v.defaultVal ? `DEFAULT ${v.defaultVal}` : null,
      });
    }
    await updateAudited(tx, tfProject, { defaultColSetId: setId }, MIGRATION_AUDIT).where(
      eq(tfProject.projectId, projectId),
    );
    return {
      source: legacy.length,
      loaded: inserted.length,
      excluded: 0,
      flagged: 0,
      rules: [
        { rule: 'R14', source: legacy.length, loaded: inserted.length, excluded: 0, flagged: 0 },
        { rule: 'R16', source: legacy.length, loaded: legacy.length, excluded: 0, flagged: 0 },
        { rule: R19_RULE, source: legacy.length, loaded: r19, excluded: 0, flagged: 0 },
      ],
      message: `세트 '${DEFAULT_SET_NM}'(set_id ${setId}) + ${inserted.length}행, RETAILV1 default_col_set_id 지정 · R19 물리명 정정 ${r19}`,
    };
  },
};
