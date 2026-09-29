import { eq, sql } from 'drizzle-orm';
import { BIZ_CD_RE, TABLE_PREFIX_RE, type ImportIssue } from '@termflow/shared';
import { insertAudited, updateAudited } from '../../db/audit.js';
import { prjBizArea } from '../../db/schema.js';
import { auditJson, writeStdAudit } from '../std-audit.js';
import { rowsOf } from '../std-sql.js';
import {
  diff,
  FileKeys,
  finish,
  intCell,
  issue,
  optText,
  reqText,
  ynCell,
  type KindEngine,
  type Planned,
} from './engine.js';

type BizRow = typeof prjBizArea.$inferSelect;
interface State {
  byCd: Map<string, { row: BizRow; tableCnt: number }>;
  maxSort: number;
}
interface Op {
  existing: BizRow | null;
  values: {
    bizCd: string;
    bizNm: string;
    tablePrefix: string | null;
    sortNo: number;
    useYn: boolean;
    description: string | null;
  };
}

/**
 * 업무구분 일괄 등록(§9.4: 업무구분코드* · 업무구분명* · 테이블접두어 · 정렬 · 사용여부(Y/N) · 설명). 키 = 업무구분코드.
 * 테이블이 있는 업무구분의 접두어 변경·사용 중지는 ERROR `E_BIZ_AREA_IN_USE`(§4.2 잠금). 빈 선택 칸은 기존 값 유지,
 * 신규의 빈 접두어는 `코드_`.
 */
export const bizAreasEngine: KindEngine<State, Op> = {
  kind: 'biz-areas',
  entityType: 'BIZ_AREA',
  title: '업무구분',
  columns: [
    { key: 'bizCd', label: '업무구분코드', required: true },
    { key: 'bizNm', label: '업무구분명', required: true },
    { key: 'tablePrefix', label: '테이블접두어', required: false },
    { key: 'sortNo', label: '정렬', required: false },
    { key: 'useYn', label: '사용여부', required: false },
    { key: 'description', label: '설명', required: false },
  ],
  example: ['CM', '공통', 'CM_', 9, 'Y', '공통 테이블'],
  notes: [
    '업무구분코드는 영대문자로 시작하는 영대문자·숫자 2~10자입니다. 사용여부는 Y 또는 N입니다.',
    '테이블이 있는 업무구분은 테이블 접두어를 바꾸거나 사용 중지할 수 없습니다.',
  ],

  async load(q, projectId) {
    const rows = await q.select().from(prjBizArea).where(eq(prjBizArea.projectId, projectId));
    const cnt = await rowsOf<{ id: number; n: number }>(
      q,
      sql`select biz_area_id id, count(*)::int n from prj_table where project_id = ${projectId} group by 1`,
    );
    const byId = new Map(cnt.map((c) => [c.id, c.n]));
    return {
      byCd: new Map(rows.map((r) => [r.bizCd, { row: r, tableCnt: byId.get(r.bizAreaId) ?? 0 }])),
      maxSort: Math.max(0, ...rows.map((r) => r.sortNo)),
    };
  },

  plan(rows, state): Planned<Op>[] {
    const keys = new FileKeys();
    let nextSort = state.maxSort;
    return rows.map((r) => {
      const errors: ImportIssue[] = [];
      const bizCd = reqText(r.cells, 'bizCd', '업무구분코드', 10, errors);
      if (bizCd !== '' && !BIZ_CD_RE.test(bizCd))
        errors.push(
          issue(
            'E_FORMAT',
            `업무구분코드 '${bizCd}'는 영대문자로 시작하는 영대문자·숫자 2~10자입니다`,
            'bizCd',
          ),
        );
      const bizNm = reqText(r.cells, 'bizNm', '업무구분명', 100, errors);
      const prefix = optText(r.cells, 'tablePrefix', '테이블접두어', 20, errors);
      if (prefix !== null && !TABLE_PREFIX_RE.test(prefix))
        errors.push(
          issue(
            'E_FORMAT',
            `테이블접두어 '${prefix}' 형식 오류(영대문자 시작, 영대문자·숫자·_)`,
            'tablePrefix',
          ),
        );
      const sortNo = intCell(r.cells, 'sortNo', '정렬', 0, 32767, errors);
      const useYn = ynCell(r.cells, 'useYn', '사용여부', errors);
      const description = optText(r.cells, 'description', '설명', 500, errors);
      if (bizCd !== '') keys.claim(bizCd, r.rowNo, errors, '업무구분코드');

      const hit = state.byCd.get(bizCd);
      const changes: Record<string, [unknown, unknown]> = {};
      if (hit) {
        const cur = hit.row;
        diff(changes, 'bizNm', cur.bizNm, bizNm);
        diff(changes, 'tablePrefix', cur.tablePrefix, prefix ?? undefined);
        diff(changes, 'sortNo', cur.sortNo, sortNo ?? undefined);
        diff(changes, 'useYn', cur.useYn, useYn ?? undefined);
        diff(changes, 'description', cur.description, description ?? undefined);
        if (hit.tableCnt > 0) {
          const blocked = [
            changes['tablePrefix'] ? '테이블 접두어 변경' : null,
            cur.useYn && useYn === false ? '사용 중지' : null,
          ].filter(Boolean);
          if (blocked.length > 0)
            errors.push(
              issue(
                'E_BIZ_AREA_IN_USE',
                `테이블 ${hit.tableCnt}개가 있어 ${blocked.join('·')}을(를) 할 수 없습니다`,
              ),
            );
        }
      }
      const values = hit
        ? {
            bizCd,
            bizNm,
            tablePrefix: prefix ?? hit.row.tablePrefix,
            sortNo: sortNo ?? hit.row.sortNo,
            useYn: useYn ?? hit.row.useYn,
            description: description ?? hit.row.description,
          }
        : {
            bizCd,
            bizNm,
            tablePrefix: prefix ?? `${bizCd}_`,
            sortNo: sortNo ?? (errors.length === 0 ? ++nextSort : 0),
            useYn: useYn ?? true,
            description,
          };
      return finish(
        { rowNo: r.rowNo, key: bizCd, values: { ...values }, changes, errors, warnings: [] },
        !hit,
        { existing: hit?.row ?? null, values },
      );
    });
  },

  async apply(tx, projectId, rows, _state, a, batchId) {
    let created = 0;
    let updated = 0;
    for (const p of rows) {
      if (!p.op) continue;
      const { existing, values } = p.op;
      if (!existing) {
        const [r] = await insertAudited(tx, prjBizArea, { projectId, ...values }, a).returning();
        await writeStdAudit(
          tx,
          {
            projectId,
            entityType: 'BIZ_AREA',
            entityId: r!.bizAreaId,
            action: 'IMPORT',
            after: auditJson(r),
            batchId,
          },
          a,
        );
        created++;
      } else {
        const [after] = await updateAudited(tx, prjBizArea, values, a)
          .where(eq(prjBizArea.bizAreaId, existing.bizAreaId))
          .returning();
        await writeStdAudit(
          tx,
          {
            projectId,
            entityType: 'BIZ_AREA',
            entityId: existing.bizAreaId,
            action: 'IMPORT',
            before: auditJson(existing),
            after: auditJson(after),
            batchId,
          },
          a,
        );
        updated++;
      }
    }
    return { new: created, update: updated };
  },
};
