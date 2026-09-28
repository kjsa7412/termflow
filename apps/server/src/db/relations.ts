/**
 * Drizzle 관계 정의(T2.2) — 손으로 쓴다. pull이 만드는 relations.ts는 복합 FK 관계가 부정확하고
 * 확장자 없는 import라 쓰지 않는다(PoC T1.4). 관계는 쿼리 API(`db.query.*.findMany({ with })`)용이며
 * 제약의 진실은 drizzle/*.sql이다. 복합 FK(project_id, *_id)는 두 열을 모두 fields/references로 적는다.
 */
import { relations } from 'drizzle-orm';
import {
  ddlExportLog,
  prjBizArea,
  prjColumn,
  prjTable,
  prjTableHistory,
  projectCopyLog,
  stdAuditLog,
  stdCode,
  stdCodeCls,
  stdDefaultCol,
  stdDefaultColSet,
  stdDomain,
  stdDomainCls,
  stdTerm,
  tfProject,
  tfProjectMember,
  tfUser,
} from './schema.js';

export const tfUserRelations = relations(tfUser, ({ many }) => ({
  memberships: many(tfProjectMember),
}));

export const tfProjectRelations = relations(tfProject, ({ one, many }) => ({
  members: many(tfProjectMember),
  bizAreas: many(prjBizArea),
  terms: many(stdTerm),
  domainClasses: many(stdDomainCls),
  domains: many(stdDomain),
  codeClasses: many(stdCodeCls),
  codes: many(stdCode),
  defaultColSets: many(stdDefaultColSet, { relationName: 'defaultColSetProject' }),
  defaultColSet: one(stdDefaultColSet, {
    fields: [tfProject.projectId, tfProject.defaultColSetId],
    references: [stdDefaultColSet.projectId, stdDefaultColSet.setId],
    relationName: 'projectDefaultColSet',
  }),
  tables: many(prjTable),
  auditLogs: many(stdAuditLog),
  exportLogs: many(ddlExportLog),
  copyLogs: many(projectCopyLog),
}));

export const tfProjectMemberRelations = relations(tfProjectMember, ({ one }) => ({
  project: one(tfProject, {
    fields: [tfProjectMember.projectId],
    references: [tfProject.projectId],
  }),
  user: one(tfUser, { fields: [tfProjectMember.userId], references: [tfUser.userId] }),
}));

export const prjBizAreaRelations = relations(prjBizArea, ({ one, many }) => ({
  project: one(tfProject, { fields: [prjBizArea.projectId], references: [tfProject.projectId] }),
  codeClasses: many(stdCodeCls),
  tables: many(prjTable),
}));

export const stdTermRelations = relations(stdTerm, ({ one }) => ({
  project: one(tfProject, { fields: [stdTerm.projectId], references: [tfProject.projectId] }),
}));

export const stdDomainClsRelations = relations(stdDomainCls, ({ one, many }) => ({
  project: one(tfProject, { fields: [stdDomainCls.projectId], references: [tfProject.projectId] }),
  domains: many(stdDomain),
}));

export const stdDomainRelations = relations(stdDomain, ({ one, many }) => ({
  project: one(tfProject, { fields: [stdDomain.projectId], references: [tfProject.projectId] }),
  domainCls: one(stdDomainCls, {
    fields: [stdDomain.projectId, stdDomain.domainClsId],
    references: [stdDomainCls.projectId, stdDomainCls.domainClsId],
  }),
  columns: many(prjColumn),
}));

export const stdCodeClsRelations = relations(stdCodeCls, ({ one, many }) => ({
  project: one(tfProject, { fields: [stdCodeCls.projectId], references: [tfProject.projectId] }),
  bizArea: one(prjBizArea, {
    fields: [stdCodeCls.projectId, stdCodeCls.bizAreaId],
    references: [prjBizArea.projectId, prjBizArea.bizAreaId],
  }),
  codes: many(stdCode),
  columns: many(prjColumn),
}));

export const stdCodeRelations = relations(stdCode, ({ one }) => ({
  project: one(tfProject, { fields: [stdCode.projectId], references: [tfProject.projectId] }),
  codeCls: one(stdCodeCls, {
    fields: [stdCode.projectId, stdCode.codeClsId],
    references: [stdCodeCls.projectId, stdCodeCls.codeClsId],
  }),
}));

export const stdDefaultColSetRelations = relations(stdDefaultColSet, ({ one, many }) => ({
  project: one(tfProject, {
    fields: [stdDefaultColSet.projectId],
    references: [tfProject.projectId],
    relationName: 'defaultColSetProject',
  }),
  columns: many(stdDefaultCol),
}));

export const stdDefaultColRelations = relations(stdDefaultCol, ({ one, many }) => ({
  set: one(stdDefaultColSet, {
    fields: [stdDefaultCol.projectId, stdDefaultCol.setId],
    references: [stdDefaultColSet.projectId, stdDefaultColSet.setId],
  }),
  columns: many(prjColumn),
}));

export const prjTableRelations = relations(prjTable, ({ one, many }) => ({
  project: one(tfProject, { fields: [prjTable.projectId], references: [tfProject.projectId] }),
  bizArea: one(prjBizArea, {
    fields: [prjTable.projectId, prjTable.bizAreaId],
    references: [prjBizArea.projectId, prjBizArea.bizAreaId],
  }),
  columns: many(prjColumn),
  history: many(prjTableHistory),
}));

export const prjColumnRelations = relations(prjColumn, ({ one }) => ({
  table: one(prjTable, {
    fields: [prjColumn.projectId, prjColumn.tableId],
    references: [prjTable.projectId, prjTable.tableId],
  }),
  domain: one(stdDomain, {
    fields: [prjColumn.projectId, prjColumn.domainId],
    references: [stdDomain.projectId, stdDomain.domainId],
  }),
  codeCls: one(stdCodeCls, {
    fields: [prjColumn.projectId, prjColumn.codeClsId],
    references: [stdCodeCls.projectId, stdCodeCls.codeClsId],
  }),
  defaultCol: one(stdDefaultCol, {
    fields: [prjColumn.projectId, prjColumn.defaultColId],
    references: [stdDefaultCol.projectId, stdDefaultCol.defaultColId],
  }),
}));

export const prjTableHistoryRelations = relations(prjTableHistory, ({ one }) => ({
  table: one(prjTable, { fields: [prjTableHistory.tableId], references: [prjTable.tableId] }),
}));

export const stdAuditLogRelations = relations(stdAuditLog, ({ one }) => ({
  project: one(tfProject, { fields: [stdAuditLog.projectId], references: [tfProject.projectId] }),
}));

export const ddlExportLogRelations = relations(ddlExportLog, ({ one }) => ({
  project: one(tfProject, { fields: [ddlExportLog.projectId], references: [tfProject.projectId] }),
}));

export const projectCopyLogRelations = relations(projectCopyLog, ({ one }) => ({
  project: one(tfProject, {
    fields: [projectCopyLog.projectId],
    references: [tfProject.projectId],
  }),
}));
