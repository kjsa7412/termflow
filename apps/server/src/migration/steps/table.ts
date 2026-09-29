import { and, count, eq, sql } from 'drizzle-orm';
import { DIALECTS, type MatchType, type StdType } from '@termflow/shared';
import { isReserved } from '../../ddl/reserved-words.js';
import { MIGRATION_AUDIT } from '../../common/audit/audit.js';
import { insertMigrated } from '../../db/audit.js';
import { prjBizArea, prjColumn, prjTable, prjTableHistory } from '../../db/schema.js';
import { parseStdType } from '../../standard/std-type-parser.js';
import { findProjectId, RMS, StepFailure, type StepDef, type Tx } from '../context.js';
import { readColumns, readTables, type LegacyColumn } from '../legacy-reader.js';
import { normalizePhysicalName } from '../rules/r09-physical-name.js';
import { migratedTimes } from '../rules/r13-audit.js';
import type { Db } from '../../db/client.js';

/**
 * step 10 TABLE/COLUMN(T5.10, 설계서 §11.1·§11.2). legacy 33 테이블·649 컬럼 → RMS 업무구분 RP.
 * 규칙: R6(FINAL·legacy_table_id·PK nullable 보정·EXACT/DEFAULT 연결), R7-b(코멘트의 코드구분), R9(물리명 대문자),
 * R10(타입 없음 → 도메인 타입 → 같은 물리명 컬럼 타입 추정 → 없으면 NULL + review), R11(테이블 내 물리명 중복이면 중단),
 * R13(감사 주체 MIGRATION·원본 일시), R16(타입 3분할), R17(PK 없음 review), R18(코멘트 = 논리명). 이력 MIGRATE 1건/테이블(§8.3).
 * 참조(도메인·코드구분·기본컬럼)는 모두 **RMS의 사본** — 복합 FK가 교차 프로젝트 참조를 막는다(C-D1).
 */
export const LEGACY_BIZ_CD = 'RP';
/** R7-b: 코멘트가 업무구분 코드 + 코드구분(예 RP040). */
const CODE_COMMENT_RE = /^([A-Z]{2})(\d{3})$/;

interface RmsRefs {
  domainByLogical: Map<string, { id: number; type: StdType | null; length: number | null; scale: number | null }>;
  defaultColByPhysical: Map<string, number>;
  codeClsByKey: Map<string, number[]>;
}

async function loadRefs(q: Db | Tx, rmsId: number): Promise<RmsRefs> {
  const d = await q.execute(
    sql`select domain_id, logical_nm, col_type, col_length, col_scale from std_domain where project_id = ${rmsId}`,
  );
  const dc = await q.execute(
    sql`select c.default_col_id, c.physical_nm from std_default_col c
          join tf_project p on p.project_id = c.project_id and p.default_col_set_id = c.set_id
         where c.project_id = ${rmsId}`,
  );
  const cc = await q.execute(
    sql`select c.code_cls_id, b.biz_cd || c.code_cls k from std_code_cls c
          join prj_biz_area b on b.biz_area_id = c.biz_area_id where c.project_id = ${rmsId}`,
  );
  const codeClsByKey = new Map<string, number[]>();
  for (const r of cc.rows as { code_cls_id: number; k: string }[]) {
    codeClsByKey.set(r.k, [...(codeClsByKey.get(r.k) ?? []), r.code_cls_id]);
  }
  return {
    domainByLogical: new Map(
      (d.rows as { domain_id: number; logical_nm: string; col_type: StdType | null; col_length: number | null; col_scale: number | null }[]).map(
        (r) => [r.logical_nm, { id: r.domain_id, type: r.col_type, length: r.col_length, scale: r.col_scale }],
      ),
    ),
    defaultColByPhysical: new Map(
      (dc.rows as { default_col_id: number; physical_nm: string }[]).map((r) => [r.physical_nm, r.default_col_id]),
    ),
    codeClsByKey,
  };
}

const blank = (v: string | null | undefined) => v === null || v === undefined || v.trim() === '';

export const tableStep: StepDef = {
  name: 'TABLE',
  isDone: async ({ db }) => {
    const rmsId = await findProjectId(db, RMS.key);
    if (rmsId === null) return false;
    const [r] = await db.select({ n: count() }).from(prjTable).where(eq(prjTable.projectId, rmsId));
    return (r?.n ?? 0) > 0;
  },
  async run({ tx, report }) {
    const rmsId = await findProjectId(tx, RMS.key);
    if (rmsId === null) throw new StepFailure('RMS가 없습니다 — 먼저 COPY_TO_RMS step을 실행하십시오');
    const [rp] = await tx
      .select({ id: prjBizArea.bizAreaId, prefix: prjBizArea.tablePrefix })
      .from(prjBizArea)
      .where(and(eq(prjBizArea.projectId, rmsId), eq(prjBizArea.bizCd, LEGACY_BIZ_CD)));
    if (!rp) throw new StepFailure(`RMS에 업무구분 ${LEGACY_BIZ_CD}가 없습니다`);
    const refs = await loadRefs(tx, rmsId);
    const tables = await readTables(tx);
    const columns = await readColumns(tx);
    for (const f of [
      'r06_tables',
      'r06_pk_nullable_fixed',
      'r07b_column_code_cls',
      'r09_physical_normalized',
      'r10_column_type_review',
      'r11_dup_reserved',
      'r16_type_parse',
      'r17_no_pk',
    ]) {
      report.declare(f);
    }
    const colsByTable = new Map<string, LegacyColumn[]>();
    for (const c of columns) colsByTable.set(c.table_id, [...(colsByTable.get(c.table_id) ?? []), c]);
    const orphans = columns.filter((c) => !tables.some((t) => t.table_id === c.table_id));
    if (orphans.length > 0) throw new StepFailure(`테이블 없는 컬럼 ${orphans.length}건`);

    // R11: 테이블 내 물리명 중복(0건 예상) → 적재 중단
    const dups: string[] = [];
    for (const [tid, cols] of colsByTable) {
      const seen = new Map<string, number>();
      for (const c of cols) {
        const p = c.physical_col_nm.trim().toUpperCase();
        if (seen.has(p)) {
          dups.push(`${tid}.${p}`);
          report.add('r11_dup_reserved', {
            rule: 'R11',
            step: 'TABLE',
            legacyKey: `${tid}#${c.col_seq}`,
            targetTable: 'prj_column',
            targetId: null,
            field: 'physical_nm',
            before: p,
            after: null,
            action: 'ERROR',
            note: `${seen.get(p)}번째 컬럼과 물리명 중복`,
          });
        }
        seen.set(p, c.col_seq);
      }
    }
    if (dups.length > 0) throw new StepFailure(`R11 테이블 내 물리명 중복: ${dups.join(', ')}`);

    // R11 확장(§6.9, CR-04 C15 → 단계 7): 테이블·컬럼 물리명을 3방언 예약어와 대조 — 리포트만(적재는 계속).
    // 기본 방언(PostgreSQL) 예약어는 DDL 생성 시 E_RESERVED, 다른 방언은 W_RESERVED_OTHER가 된다.
    let reservedHits = 0;
    const reservedCheck = (legacyKey: string, table: string, field: string, name: string) => {
      for (const d of DIALECTS) {
        if (!isReserved(d, name)) continue;
        reservedHits++;
        report.add('r11_dup_reserved', {
          rule: 'R11',
          step: 'TABLE',
          legacyKey,
          targetTable: table,
          targetId: null,
          field,
          before: name,
          after: null,
          action: 'REVIEW',
          note: `${d} 예약어 — ${d === 'POSTGRESQL' ? 'E_RESERVED(비인용 DDL 불가)' : 'W_RESERVED_OTHER'}`,
        });
      }
    };
    for (const t of tables) reservedCheck(t.table_id, 'prj_table', 'table_nm', t.table_nm.trim().toUpperCase());
    for (const c of columns) {
      reservedCheck(`${c.table_id}#${c.col_seq}`, 'prj_column', 'physical_nm', c.physical_col_nm.trim().toUpperCase());
    }

    // 같은 물리명 컬럼의 확정 타입(R10 추정용): 물리명 → 파싱된 타입 집합
    const typeByPhysical = new Map<string, Set<string>>();
    for (const c of columns) {
      const parsed = parseStdType(c.data_type);
      if (!parsed.ok) continue;
      const p = c.physical_col_nm.trim().toUpperCase();
      typeByPhysical.set(p, new Set([...(typeByPhysical.get(p) ?? []), parsed.normalized]));
    }

    const c = { r9: 0, r10Src: 0, r10: 0, r10Review: 0, r16: 0, r17: 0, r18: 0, pkFix: 0, exact: 0, dflt: 0, code: 0, r7bSkip: 0 };
    // ── 테이블 ────────────────────────────────────────────────────
    const tableValues = tables.map((t) => {
      const nm = normalizePhysicalName(t.table_nm, /^[A-Z][A-Z0-9_]*$/);
      if (nm.value === null || nm.formatError) throw new StepFailure(`테이블 물리명 형식 오류: ${t.table_nm}`);
      if (nm.changed) {
        c.r9++;
        report.add('r09_physical_normalized', {
          rule: 'R09',
          step: 'TABLE',
          legacyKey: t.table_id,
          targetTable: 'prj_table',
          targetId: null,
          field: 'table_nm',
          before: t.table_nm,
          after: nm.value,
          action: 'NORMALIZED',
        });
      }
      const cols = colsByTable.get(t.table_id) ?? [];
      const noPk = !cols.some((x) => x.is_key === 'Y');
      const notes: string[] = [];
      if (noPk) {
        c.r17++;
        notes.push('PK 없음');
        report.add('r17_no_pk', {
          rule: 'R17',
          step: 'TABLE',
          legacyKey: t.table_id,
          targetTable: 'prj_table',
          targetId: null,
          field: 'is_pk',
          before: null,
          after: null,
          action: 'REVIEW',
          note: `${nm.value} ${t.table_logical_nm}: PK 없음(자동 수정 없음, FINAL 유지)`,
        });
      }
      if (rp.prefix && !nm.value.startsWith(rp.prefix)) notes.push(`접두어 ${rp.prefix} 아님`);
      const times = migratedTimes(t.firs_reg_dts, t.fina_reg_dts);
      return {
        legacy: t,
        value: {
          projectId: rmsId,
          bizAreaId: rp.id,
          tableNm: nm.value,
          tableLogicalNm: t.table_logical_nm.trim(),
          description: blank(t.description) ? null : t.description,
          status: 'FINAL',
          version: 1,
          finalizedAt: t.fina_reg_dts ?? t.firs_reg_dts,
          finalizedBy: MIGRATION_AUDIT.actor,
          legacyTableId: t.table_id,
          reviewYn: notes.length > 0,
          reviewNote: notes.length > 0 ? notes.join(' · ') : null,
          ...times,
        },
      };
    });
    const insertedTables = await insertMigrated(
      tx,
      prjTable,
      tableValues.map((t) => t.value),
      MIGRATION_AUDIT,
      (q) => q.returning({ id: prjTable.tableId, legacy: prjTable.legacyTableId }),
    );
    const tableIdByLegacy = new Map(insertedTables.map((r) => [r.legacy!, r.id]));
    for (const t of tableValues) {
      report.add('r06_tables', {
        rule: 'R06',
        step: 'TABLE',
        legacyKey: t.legacy.table_id,
        targetTable: 'prj_table',
        targetId: tableIdByLegacy.get(t.legacy.table_id) ?? null,
        field: 'table_id',
        before: t.legacy.table_id,
        after: t.value.tableNm,
        action: 'NORMALIZED',
        note: `컬럼 ${(colsByTable.get(t.legacy.table_id) ?? []).length} · ${LEGACY_BIZ_CD} · FINAL`,
      });
    }

    // ── 컬럼 ──────────────────────────────────────────────────────
    const typeReviewByTable = new Map<number, string[]>();
    const columnValues = columns.map((col) => {
      const tableId = tableIdByLegacy.get(col.table_id)!;
      const key = `${col.table_id}#${col.col_seq}`;
      const add = (file: string, rule: string, field: string, before: unknown, after: unknown, action: 'NORMALIZED' | 'RECALC' | 'REVIEW' | 'MANUAL', note?: string) =>
        report.add(file, {
          rule,
          step: 'TABLE',
          legacyKey: key,
          targetTable: 'prj_column',
          targetId: null,
          field,
          before: before as string | null,
          after: after as string | null,
          action,
          note: note ?? null,
        });
      const logicalNm = col.logical_col_nm.trim();
      const phys = normalizePhysicalName(col.physical_col_nm, /^[A-Z][A-Z0-9_]*$/);
      if (phys.value === null || phys.formatError || phys.tooLong)
        throw new StepFailure(`컬럼 물리명 오류(자동 수정 없음): ${key} ${col.physical_col_nm}`);
      if (phys.changed) {
        c.r9++;
        add('r09_physical_normalized', 'R09', 'physical_nm', col.physical_col_nm, phys.value, 'NORMALIZED');
      }
      const isPk = col.is_key === 'Y';
      let isNullable = col.is_nullable !== 'N';
      if (isPk && isNullable) {
        isNullable = false;
        c.pkFix++;
        add('r06_pk_nullable_fixed', 'R06', 'is_nullable', 'Y', 'N', 'NORMALIZED', `PK 컬럼 ${phys.value} nullable 보정`);
      }
      // 참조(RMS 사본)
      const domain = refs.domainByLogical.get(logicalNm);
      const defaultColId = refs.defaultColByPhysical.get(phys.value) ?? null;
      let codeClsId: number | null = null;
      let comment = blank(col.col_comment) ? null : col.col_comment!.trim();
      const m = comment ? CODE_COMMENT_RE.exec(comment) : null;
      if (m) {
        const hits = refs.codeClsByKey.get(`${m[1]}${m[2]}`) ?? [];
        if (hits.length === 1) {
          codeClsId = hits[0]!;
          c.code++;
          add('r07b_column_code_cls', 'R07b', 'code_cls_id', comment, codeClsId, 'NORMALIZED', `${phys.value}: 코멘트 ${comment} → 코드구분, 코멘트는 논리명으로(R18)`);
          comment = null;
        } else {
          c.r7bSkip++;
          add('r07b_column_code_cls', 'R07b', 'code_cls_id', comment, null, 'REVIEW', hits.length === 0 ? 'RMS에 코드구분 없음' : `코드구분 ${hits.length}개 — 업무구분 유일하지 않음`);
        }
      }
      if (comment === null) c.r18++;
      // 타입(R16 → R10)
      let dataType: StdType | null = null;
      let dataLength: number | null = null;
      let dataScale: number | null = null;
      const parsed = parseStdType(col.data_type);
      if (parsed.ok) {
        dataType = parsed.type;
        dataLength = parsed.length;
        dataScale = parsed.scale;
        const raw = (col.data_type ?? '').trim();
        if (raw !== parsed.normalized) {
          c.r16++;
          add('r16_type_parse', 'R16', 'data_type', raw, parsed.normalized, 'NORMALIZED');
        }
      } else if (parsed.reason === 'EMPTY') {
        c.r10Src++;
        const known = typeByPhysical.get(phys.value);
        if (domain?.type) {
          dataType = domain.type;
          dataLength = domain.length;
          dataScale = domain.scale;
          c.r10++;
          add('r10_column_type_review', 'R10', 'data_type', null, `${dataType}`, 'RECALC', `도메인 '${logicalNm}' 타입`);
        } else if (known && known.size === 1) {
          const p2 = parseStdType([...known][0]);
          if (p2.ok) {
            dataType = p2.type;
            dataLength = p2.length;
            dataScale = p2.scale;
          }
          c.r10++;
          c.r10Review++;
          add('r10_column_type_review', 'R10', 'data_type', null, [...known][0], 'REVIEW', `같은 물리명(${phys.value}) 컬럼의 타입으로 추정 — 확인 필요(R16)`);
          typeReviewByTable.set(tableId, [...(typeReviewByTable.get(tableId) ?? []), phys.value]);
        } else {
          c.r10Review++;
          add('r10_column_type_review', 'R10', 'data_type', null, null, 'REVIEW', '타입 없음 — NULL 유지(VARCHAR(100) 대체 금지)');
          typeReviewByTable.set(tableId, [...(typeReviewByTable.get(tableId) ?? []), phys.value]);
        }
      } else {
        c.r10Review++;
        add('r16_type_parse', 'R16', 'data_type', col.data_type, null, 'REVIEW', `파싱 불가(${parsed.reason}) — NULL 유지`);
        typeReviewByTable.set(tableId, [...(typeReviewByTable.get(tableId) ?? []), phys.value]);
      }
      if (domain) c.exact++;
      if (defaultColId !== null) c.dflt++;
      const matchType: MatchType =
        codeClsId !== null ? 'CODE' : defaultColId !== null ? 'DEFAULT' : domain ? 'EXACT' : 'MANUAL';
      return {
        projectId: rmsId,
        tableId,
        colSeq: col.col_seq,
        logicalNm,
        physicalNm: phys.value,
        isPk,
        dataType,
        dataLength,
        dataScale,
        isNullable,
        defaultVal: blank(col.default_val) ? null : col.default_val!.trim(),
        colComment: comment ?? logicalNm,
        domainId: domain?.id ?? null,
        codeClsId,
        defaultColId,
        matchType,
        ...migratedTimes(col.firs_reg_dts, col.fina_reg_dts),
      };
    });
    const insertedCols = await insertMigrated(tx, prjColumn, columnValues, MIGRATION_AUDIT, (q) =>
      q.returning({ id: prjColumn.columnId, tableId: prjColumn.tableId, colSeq: prjColumn.colSeq }),
    );
    // R10 추정·NULL 타입은 테이블 review 메모에 남긴다(컬럼에는 review 열이 없다)
    for (const [tableId, names] of typeReviewByTable) {
      await tx.execute(
        sql`update prj_table set review_yn = true,
              review_note = left(coalesce(review_note || ' · ', '') || ${`타입 확인 필요: ${names.join(', ')}`}, 500)
            where table_id = ${tableId}`,
      );
    }

    // 이력 MIGRATE 스냅샷(§8.3) 1건/테이블
    const idBySeq = new Map(insertedCols.map((r) => [`${r.tableId}#${r.colSeq}`, r.id]));
    const tableRows = await tx.execute(
      sql`select t.table_id, t.table_nm, t.table_logical_nm, t.description, t.status, t.version,
                 to_char(t.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS') saved_at
            from prj_table t where t.project_id = ${rmsId}`,
    );
    const history = (tableRows.rows as {
      table_id: number;
      table_nm: string;
      table_logical_nm: string;
      description: string | null;
      status: string;
      version: number;
      saved_at: string;
    }[]).map((t) => {
      const cols = columnValues
        .filter((v) => v.tableId === t.table_id)
        .sort((x, y) => x.colSeq - y.colSeq)
        .map((v) => ({
          columnId: idBySeq.get(`${v.tableId}#${v.colSeq}`) ?? null,
          colSeq: v.colSeq,
          logicalNm: v.logicalNm,
          physicalNm: v.physicalNm,
          isPk: v.isPk,
          dataType: v.dataType,
          dataLength: v.dataLength,
          dataScale: v.dataScale,
          isNullable: v.isNullable,
          defaultVal: v.defaultVal,
          colComment: v.colComment,
          domainId: v.domainId,
          codeClsId: v.codeClsId,
          defaultColId: v.defaultColId,
          matchType: v.matchType,
        }));
      const legacyId = tableValues.find((x) => tableIdByLegacy.get(x.legacy.table_id) === t.table_id)?.legacy.table_id;
      const summary = `승계 이관(${legacyId ?? '?'}) · 컬럼 ${cols.length}`;
      return {
        tableId: t.table_id,
        version: t.version,
        action: 'MIGRATE',
        changeSummary: summary,
        snapshot: {
          schemaVersion: 1,
          table: {
            tableId: t.table_id,
            projectKey: RMS.key,
            bizCd: LEGACY_BIZ_CD,
            bizAreaId: rp.id,
            tableNm: t.table_nm,
            tableLogicalNm: t.table_logical_nm,
            description: t.description,
            status: t.status,
            version: t.version,
          },
          columns: cols,
          action: 'MIGRATE',
          changeSummary: summary,
          savedBy: MIGRATION_AUDIT.actor,
          savedAt: t.saved_at,
        },
        savedBy: MIGRATION_AUDIT.actor,
        savedIp: null,
        savedAt: t.saved_at.replace('T', ' '),
      };
    });
    await tx.insert(prjTableHistory).values(history);

    return {
      source: tables.length + columns.length,
      loaded: insertedTables.length + insertedCols.length,
      excluded: 0,
      flagged: c.r17 + c.r10Review,
      rules: [
        { rule: 'R06', source: columns.length, loaded: insertedCols.length, excluded: 0, flagged: c.pkFix },
        { rule: 'R07b', source: c.code + c.r7bSkip, loaded: c.code, excluded: 0, flagged: c.r7bSkip },
        { rule: 'R09', source: tables.length + columns.length, loaded: c.r9, excluded: 0, flagged: 0 },
        { rule: 'R10', source: c.r10Src, loaded: c.r10, excluded: 0, flagged: c.r10Review },
        { rule: 'R11', source: tables.length + columns.length, loaded: 0, excluded: 0, flagged: reservedHits },
        { rule: 'R16', source: columns.length, loaded: c.r16, excluded: 0, flagged: 0 },
        { rule: 'R17', source: tables.length, loaded: 0, excluded: 0, flagged: c.r17 },
        { rule: 'R18', source: columns.length, loaded: c.r18, excluded: 0, flagged: 0 },
      ],
      message:
        `테이블 ${insertedTables.length}·컬럼 ${insertedCols.length}(업무구분 ${LEGACY_BIZ_CD}, FINAL) · ` +
        `도메인 연결(EXACT 일치) ${c.exact} · 기본컬럼 연결 ${c.dflt} · 코드구분(R7-b) ${c.code} · ` +
        `PK nullable 보정 ${c.pkFix} · R9 ${c.r9} · R10 ${c.r10}(검토 ${c.r10Review}) · R17 PK 없음 ${c.r17} · R18 ${c.r18} · 이력 MIGRATE ${history.length}`,
    };
  },
};
