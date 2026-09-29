import { eq, sql } from 'drizzle-orm';
import type { ImportIssue } from '@termflow/shared';
import { insertAudited } from '../../db/audit.js';
import { prjBizArea, stdCode, stdCodeCls } from '../../db/schema.js';
import { auditJson, writeStdAudit } from '../std-audit.js';
import { chunks } from '../std-sql.js';
import {
  diff,
  FileKeys,
  finish,
  intCell,
  issue,
  reqText,
  type KindEngine,
  type Planned,
} from './engine.js';

type ClsRow = typeof stdCodeCls.$inferSelect;
type CodeRow = typeof stdCode.$inferSelect;
interface State {
  bizByCd: Map<string, { bizAreaId: number; useYn: boolean }>;
  clsByKey: Map<string, ClsRow>;
  codeByKey: Map<string, CodeRow>;
}
interface Op {
  clsKey: string;
  bizAreaId: number;
  bizCd: string;
  codeCls: string;
  codeClsNm: string;
  cls: ClsRow | null;
  /** 이 행이 기존 코드구분의 이름을 바꾸는 첫 행인지. */
  renameCls: boolean;
  code: string;
  codeNm: string;
  sortOrder: number | null;
  existing: CodeRow | null;
}

const clsKeyOf = (bizAreaId: number, codeCls: string) => `${bizAreaId}/${codeCls}`;

/**
 * 코드 일괄 등록(§9.4 kind `code-classes`: 업무구분코드* · 코드구분* · 코드구분명* · 코드* · 코드명* · 정렬순서). 키 =
 * (업무구분, 코드구분, 코드) — 판정은 (업무구분, 코드구분) 쌍(CR-04 §4). **업무구분은 프로젝트에 이미 있어야 한다**(없으면 ERROR
 * `E_BIZ_AREA_NOT_FOUND`, 자동 생성 없음). 없는 코드구분은 새로 만든다(사용 중지 업무구분이면 ERROR). 같은 코드구분의 이름이 행마다
 * 다르면 뒤 행 ERROR.
 */
export const codeClassesEngine: KindEngine<State, Op> = {
  kind: 'code-classes',
  entityType: 'CODE',
  title: '코드',
  columns: [
    { key: 'bizCd', label: '업무구분코드', required: true },
    { key: 'codeCls', label: '코드구분', required: true },
    { key: 'codeClsNm', label: '코드구분명', required: true },
    { key: 'code', label: '코드', required: true },
    { key: 'codeNm', label: '코드명', required: true },
    { key: 'sortOrder', label: '정렬순서', required: false },
  ],
  example: ['RP', '020', '연구과제상태', '10', '신청', 1],
  notes: [
    '업무구분코드는 이 프로젝트에 이미 있어야 합니다(업무구분 화면에서 먼저 등록). 없는 코드구분은 새로 만듭니다.',
    '같은 코드구분의 행은 코드구분명을 같게 쓰세요. 코드구분명을 바꾸면 기존 코드구분 이름이 바뀝니다.',
  ],

  async load(q, projectId) {
    const biz = await q
      .select({ bizAreaId: prjBizArea.bizAreaId, bizCd: prjBizArea.bizCd, useYn: prjBizArea.useYn })
      .from(prjBizArea)
      .where(eq(prjBizArea.projectId, projectId));
    const cls = await q.select().from(stdCodeCls).where(eq(stdCodeCls.projectId, projectId));
    const codes = await q.select().from(stdCode).where(eq(stdCode.projectId, projectId));
    return {
      bizByCd: new Map(biz.map((b) => [b.bizCd, { bizAreaId: b.bizAreaId, useYn: b.useYn }])),
      clsByKey: new Map(cls.map((c) => [clsKeyOf(c.bizAreaId, c.codeCls), c])),
      codeByKey: new Map(codes.map((c) => [`${c.codeClsId}/${c.code}`, c])),
    };
  },

  plan(rows, state): Planned<Op>[] {
    const keys = new FileKeys();
    const clsNameInFile = new Map<string, { name: string; rowNo: number }>();
    return rows.map((r) => {
      const errors: ImportIssue[] = [];
      const bizCd = reqText(r.cells, 'bizCd', '업무구분코드', 10, errors);
      const codeCls = reqText(r.cells, 'codeCls', '코드구분', 10, errors);
      const codeClsNm = reqText(r.cells, 'codeClsNm', '코드구분명', 100, errors);
      const code = reqText(r.cells, 'code', '코드', 10, errors);
      const codeNm = reqText(r.cells, 'codeNm', '코드명', 100, errors);
      const sortOrder = intCell(r.cells, 'sortOrder', '정렬순서', -32768, 32767, errors);
      const biz = bizCd !== '' ? state.bizByCd.get(bizCd) : undefined;
      if (bizCd !== '' && !biz)
        errors.push(
          issue(
            'E_BIZ_AREA_NOT_FOUND',
            `업무구분 '${bizCd}'이(가) 프로젝트에 없습니다(자동 생성하지 않음)`,
            'bizCd',
          ),
        );
      const key = `${bizCd}/${codeCls}/${code}`;
      if (bizCd !== '' && codeCls !== '' && code !== '') keys.claim(key, r.rowNo, errors, '코드');

      const clsKey = biz ? clsKeyOf(biz.bizAreaId, codeCls) : '';
      const cls = biz ? (state.clsByKey.get(clsKey) ?? null) : null;
      let renameCls = false;
      if (biz && codeCls !== '' && codeClsNm !== '') {
        const prev = clsNameInFile.get(clsKey);
        if (prev && prev.name !== codeClsNm) {
          errors.push(
            issue(
              'E_CODE_CLS_NM_CONFLICT',
              `코드구분명 '${codeClsNm}'이(가) ${prev.rowNo}행('${prev.name}')과 다릅니다`,
              'codeClsNm',
            ),
          );
        } else if (!prev && errors.length === 0) {
          clsNameInFile.set(clsKey, { name: codeClsNm, rowNo: r.rowNo });
          renameCls = cls !== null && cls.codeClsNm !== codeClsNm;
        }
        if (!cls && !biz.useYn)
          errors.push(
            issue(
              'E_BIZ_AREA_INACTIVE',
              `사용 중지된 업무구분 '${bizCd}'에는 새 코드구분을 만들 수 없습니다`,
              'bizCd',
            ),
          );
      }
      const existing = cls ? (state.codeByKey.get(`${cls.codeClsId}/${code}`) ?? null) : null;
      const changes: Record<string, [unknown, unknown]> = {};
      if (renameCls && cls) changes['codeClsNm'] = [cls.codeClsNm, codeClsNm];
      if (existing) {
        diff(changes, 'codeNm', existing.codeNm, codeNm);
        diff(changes, 'sortOrder', existing.sortOrder, sortOrder ?? undefined);
      }
      return finish(
        {
          rowNo: r.rowNo,
          key,
          values: { bizCd, codeCls, codeClsNm, code, codeNm, sortOrder },
          changes,
          errors,
          warnings:
            !cls && errors.length === 0
              ? [issue('I_CODE_CLS_NEW', `새 코드구분 ${bizCd}/${codeCls} ${codeClsNm}`)]
              : [],
        },
        existing === null,
        {
          clsKey,
          bizAreaId: biz?.bizAreaId ?? 0,
          bizCd,
          codeCls,
          codeClsNm,
          cls,
          renameCls,
          code,
          codeNm,
          sortOrder: sortOrder ?? existing?.sortOrder ?? null,
          existing,
        },
      );
    });
  },

  async apply(tx, projectId, rows, _state, a, batchId) {
    const ops = rows.flatMap((p) => (p.op ? [p.op] : []));
    // 1) 새 코드구분(파일 첫 행의 이름으로)
    const clsIds = new Map<string, number>();
    const newCls = new Map<string, Op>();
    for (const o of ops) {
      if (o.cls) clsIds.set(o.clsKey, o.cls.codeClsId);
      else if (!newCls.has(o.clsKey)) newCls.set(o.clsKey, o);
    }
    for (const part of chunks([...newCls.values()], 500)) {
      const created = await insertAudited(
        tx,
        stdCodeCls,
        part.map((o) => ({
          projectId,
          bizAreaId: o.bizAreaId,
          codeCls: o.codeCls,
          codeClsNm: o.codeClsNm,
        })),
        a,
      ).returning();
      for (const c of created) clsIds.set(clsKeyOf(c.bizAreaId, c.codeCls), c.codeClsId);
      await writeStdAudit(
        tx,
        created.map((c) => ({
          projectId,
          entityType: 'CODE_CLS' as const,
          entityId: c.codeClsId,
          action: 'IMPORT' as const,
          after: auditJson(c),
          batchId,
        })),
        a,
      );
    }
    // 2) 코드구분 이름 변경
    for (const o of ops.filter((x) => x.renameCls && x.cls)) {
      await tx.execute(
        sql`update std_code_cls set code_cls_nm = ${o.codeClsNm}, updated_at = CURRENT_TIMESTAMP,
                   updated_by = ${a.actor}, updated_ip = ${a.ip}
             where code_cls_id = ${o.cls!.codeClsId} and project_id = ${projectId}`,
      );
      const before = auditJson(o.cls) as Record<string, unknown>;
      await writeStdAudit(
        tx,
        {
          projectId,
          entityType: 'CODE_CLS',
          entityId: o.cls!.codeClsId,
          action: 'IMPORT',
          before,
          after: { ...before, codeClsNm: o.codeClsNm },
          batchId,
        },
        a,
      );
    }
    // 3) 코드 신규·갱신
    const inserts = ops.filter((o) => o.existing === null);
    const updates = ops.filter(
      (o) =>
        o.existing !== null &&
        (o.existing.codeNm !== o.codeNm || o.existing.sortOrder !== o.sortOrder),
    );
    for (const part of chunks(inserts, 500)) {
      const created = await insertAudited(
        tx,
        stdCode,
        part.map((o) => ({
          projectId,
          codeClsId: clsIds.get(o.clsKey)!,
          code: o.code,
          codeNm: o.codeNm,
          sortOrder: o.sortOrder,
        })),
        a,
      ).returning();
      await writeStdAudit(
        tx,
        created.map((c) => ({
          projectId,
          entityType: 'CODE' as const,
          entityId: c.codeId,
          action: 'IMPORT' as const,
          after: auditJson(c),
          batchId,
        })),
        a,
      );
    }
    for (const part of chunks(updates, 1000)) {
      await tx.execute(
        sql`update std_code x set code_nm = u.nm, sort_order = u.so,
                   updated_at = CURRENT_TIMESTAMP, updated_by = ${a.actor}, updated_ip = ${a.ip}
              from unnest(${sql.param(part.map((o) => o.existing!.codeId))}::int[],
                          ${sql.param(part.map((o) => o.codeNm))}::text[],
                          ${sql.param(part.map((o) => o.sortOrder))}::smallint[]) as u(id, nm, so)
             where x.code_id = u.id and x.project_id = ${projectId}`,
      );
      await writeStdAudit(
        tx,
        part.map((o) => {
          const before = auditJson(o.existing) as Record<string, unknown>;
          return {
            projectId,
            entityType: 'CODE' as const,
            entityId: o.existing!.codeId,
            action: 'IMPORT' as const,
            before,
            after: { ...before, codeNm: o.codeNm, sortOrder: o.sortOrder },
            batchId,
          };
        }),
        a,
      );
    }
    // 이름만 바뀐 행(코드 변경 없음)은 코드구분 갱신으로 센다
    const updSet = new Set(updates);
    const renamedOnly = ops.filter(
      (o) => o.existing !== null && o.renameCls && !updSet.has(o),
    ).length;
    return { new: inserts.length, update: updates.length + renamedOnly };
  },
};
