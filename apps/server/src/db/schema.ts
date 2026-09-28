// ⚠ 자동 생성 파일 — 직접 수정 금지. `pnpm db:pull`(drizzle-kit pull + scripts/pull-postprocess.ts)로 다시 만든다.
// 진실은 drizzle/*.sql(설계서 §2.5.3). 이 파일은 쿼리 타입용이며 다음을 담지 않는다(PoC T1.4 발견):
//  - FOREIGN KEY 전부(pull의 복합 FK 열 순서 오류·SET NULL(열) 누락·순환 참조 타입 오류 때문에 제거)
//  - DEFERRABLE, ON DELETE SET NULL (열)
//  - 다열 unique의 열 순서는 attnum 순으로 나올 수 있다(메타데이터일 뿐, DDL 생성에 쓰지 않는다)
import {
  pgTable,
  unique,
  check,
  integer,
  varchar,
  text,
  boolean,
  timestamp,
  smallint,
  index,
  uniqueIndex,
  bigint,
  jsonb,
  json,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const tfProject = pgTable(
  'tf_project',
  {
    projectId: integer('project_id').primaryKey().generatedAlwaysAsIdentity({
      name: 'tf_project_project_id_seq',
      startWith: 1,
      increment: 1,
      minValue: 1,
      maxValue: 2147483647,
      cache: 1,
    }),
    projectKey: varchar('project_key', { length: 10 }).notNull(),
    projectNm: varchar('project_nm', { length: 100 }).notNull(),
    description: text(),
    kind: varchar({ length: 10 }).default('PROJECT').notNull(),
    status: varchar({ length: 10 }).default('ACTIVE').notNull(),
    defaultDialect: varchar('default_dialect', { length: 20 }).default('POSTGRESQL').notNull(),
    defaultColSetId: integer('default_col_set_id'),
    includeDefaultCols: boolean('include_default_cols').default(true).notNull(),
    copiedFromProjectId: integer('copied_from_project_id'),
    createdAt: timestamp('created_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    createdBy: varchar('created_by', { length: 50 }).notNull(),
    createdIp: varchar('created_ip', { length: 45 }),
    updatedAt: timestamp('updated_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedBy: varchar('updated_by', { length: 50 }).notNull(),
    updatedIp: varchar('updated_ip', { length: 45 }),
  },
  (table) => [
    unique('uk_tf_project_key').on(table.projectKey),
    check('ck_tf_project_key_fmt', sql`(project_key)::text ~ '^[A-Z][A-Z0-9]{1,9}$'::text`),
    check(
      'ck_tf_project_kind',
      sql`(kind)::text = ANY ((ARRAY['PROJECT'::character varying, 'TEMPLATE'::character varying])::text[])`,
    ),
    check(
      'ck_tf_project_status',
      sql`(status)::text = ANY ((ARRAY['ACTIVE'::character varying, 'ARCHIVED'::character varying])::text[])`,
    ),
    check(
      'ck_tf_project_dialect',
      sql`(default_dialect)::text = ANY ((ARRAY['POSTGRESQL'::character varying, 'ORACLE'::character varying, 'MYSQL'::character varying])::text[])`,
    ),
  ],
);

export const tfUser = pgTable(
  'tf_user',
  {
    userId: integer('user_id').primaryKey().generatedAlwaysAsIdentity({
      name: 'tf_user_user_id_seq',
      startWith: 1,
      increment: 1,
      minValue: 1,
      maxValue: 2147483647,
      cache: 1,
    }),
    loginId: varchar('login_id', { length: 50 }).notNull(),
    userNm: varchar('user_nm', { length: 100 }).notNull(),
    email: varchar({ length: 100 }),
    passwordHash: varchar('password_hash', { length: 100 }).notNull(),
    isSysAdmin: boolean('is_sys_admin').default(false).notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    pwChangeRequired: boolean('pw_change_required').default(true).notNull(),
    loginFailCnt: smallint('login_fail_cnt').default(0).notNull(),
    lockedUntil: timestamp('locked_until', { mode: 'string' }),
    lastLoginAt: timestamp('last_login_at', { mode: 'string' }),
    createdAt: timestamp('created_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    createdBy: varchar('created_by', { length: 50 }).notNull(),
    createdIp: varchar('created_ip', { length: 45 }),
    updatedAt: timestamp('updated_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedBy: varchar('updated_by', { length: 50 }).notNull(),
    updatedIp: varchar('updated_ip', { length: 45 }),
  },
  (table) => [unique('uk_tf_user_login').on(table.loginId)],
);

export const prjBizArea = pgTable(
  'prj_biz_area',
  {
    bizAreaId: integer('biz_area_id').primaryKey().generatedAlwaysAsIdentity({
      name: 'prj_biz_area_biz_area_id_seq',
      startWith: 1,
      increment: 1,
      minValue: 1,
      maxValue: 2147483647,
      cache: 1,
    }),
    projectId: integer('project_id').notNull(),
    bizCd: varchar('biz_cd', { length: 10 }).notNull(),
    bizNm: varchar('biz_nm', { length: 100 }).notNull(),
    tablePrefix: varchar('table_prefix', { length: 20 }),
    sortNo: smallint('sort_no').default(0).notNull(),
    useYn: boolean('use_yn').default(true).notNull(),
    description: varchar({ length: 500 }),
    originProjectId: integer('origin_project_id'),
    originId: integer('origin_id'),
    createdAt: timestamp('created_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    createdBy: varchar('created_by', { length: 50 }).notNull(),
    createdIp: varchar('created_ip', { length: 45 }),
    updatedAt: timestamp('updated_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedBy: varchar('updated_by', { length: 50 }).notNull(),
    updatedIp: varchar('updated_ip', { length: 45 }),
  },
  (table) => [
    index('ix_prj_biz_area_sort').using(
      'btree',
      table.projectId.asc().nullsLast().op('int4_ops'),
      table.sortNo.asc().nullsLast().op('int2_ops'),
    ),
    unique('uk_prj_biz_area_pid').on(table.bizAreaId, table.projectId),
    unique('uk_prj_biz_area_cd').on(table.projectId, table.bizCd),
    check('ck_prj_biz_area_cd_fmt', sql`(biz_cd)::text ~ '^[A-Z][A-Z0-9]{1,9}$'::text`),
    check(
      'ck_prj_biz_area_prefix_fmt',
      sql`(table_prefix IS NULL) OR ((table_prefix)::text ~ '^[A-Z][A-Z0-9_]*$'::text)`,
    ),
  ],
);

export const stdTerm = pgTable(
  'std_term',
  {
    termId: integer('term_id').primaryKey().generatedAlwaysAsIdentity({
      name: 'std_term_term_id_seq',
      startWith: 1,
      increment: 1,
      minValue: 1,
      maxValue: 2147483647,
      cache: 1,
    }),
    projectId: integer('project_id').notNull(),
    termKor: varchar('term_kor', { length: 100 }).notNull(),
    termPhysical: varchar('term_physical', { length: 30 }),
    description: varchar({ length: 500 }),
    synonymRef: varchar('synonym_ref', { length: 200 }),
    status: varchar({ length: 10 }).default('APPROVED').notNull(),
    reviewYn: boolean('review_yn').default(false).notNull(),
    reviewNote: varchar('review_note', { length: 500 }),
    reviewedBy: varchar('reviewed_by', { length: 50 }),
    reviewedAt: timestamp('reviewed_at', { mode: 'string' }),
    originProjectId: integer('origin_project_id'),
    originId: integer('origin_id'),
    createdAt: timestamp('created_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    createdBy: varchar('created_by', { length: 50 }).notNull(),
    createdIp: varchar('created_ip', { length: 45 }),
    updatedAt: timestamp('updated_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedBy: varchar('updated_by', { length: 50 }).notNull(),
    updatedIp: varchar('updated_ip', { length: 45 }),
  },
  (table) => [
    index('ix_std_term_pending')
      .using(
        'btree',
        table.projectId.asc().nullsLast().op('int4_ops'),
        table.createdAt.asc().nullsLast().op('timestamp_ops'),
      )
      .where(sql`((status)::text = 'PENDING'::text)`),
    index('ix_std_term_physical').using(
      'btree',
      table.projectId.asc().nullsLast().op('text_ops'),
      table.termPhysical.asc().nullsLast().op('text_ops'),
    ),
    unique('uk_std_term_kor').on(table.projectId, table.termKor),
    check(
      'ck_std_term_status',
      sql`(status)::text = ANY ((ARRAY['APPROVED'::character varying, 'PENDING'::character varying, 'REJECTED'::character varying])::text[])`,
    ),
    check(
      'ck_std_term_physical_fmt',
      sql`(term_physical IS NULL) OR ((term_physical)::text ~ '^[A-Z0-9_]+$'::text)`,
    ),
  ],
);

export const stdDomainCls = pgTable(
  'std_domain_cls',
  {
    domainClsId: integer('domain_cls_id').primaryKey().generatedAlwaysAsIdentity({
      name: 'std_domain_cls_domain_cls_id_seq',
      startWith: 1,
      increment: 1,
      minValue: 1,
      maxValue: 2147483647,
      cache: 1,
    }),
    projectId: integer('project_id').notNull(),
    suffix: varchar({ length: 30 }).notNull(),
    clsNm: varchar('cls_nm', { length: 500 }).notNull(),
    colType: varchar('col_type', { length: 20 }).notNull(),
    colLength: integer('col_length'),
    colScale: integer('col_scale'),
    description: varchar({ length: 200 }),
    reviewYn: boolean('review_yn').default(false).notNull(),
    originProjectId: integer('origin_project_id'),
    originId: integer('origin_id'),
    createdAt: timestamp('created_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    createdBy: varchar('created_by', { length: 50 }).notNull(),
    createdIp: varchar('created_ip', { length: 45 }),
    updatedAt: timestamp('updated_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedBy: varchar('updated_by', { length: 50 }).notNull(),
    updatedIp: varchar('updated_ip', { length: 45 }),
  },
  (table) => [
    unique('uk_std_domain_cls_pid').on(table.domainClsId, table.projectId),
    unique('uk_std_domain_cls_suffix').on(table.projectId, table.suffix),
    check('ck_std_domain_cls_suffix_fmt', sql`(suffix)::text ~ '^[A-Z0-9_]+$'::text`),
    check(
      'ck_std_domain_cls_type',
      sql`(col_type)::text = ANY ((ARRAY['VARCHAR'::character varying, 'CHAR'::character varying, 'TEXT'::character varying, 'SMALLINT'::character varying, 'INT'::character varying, 'BIGINT'::character varying, 'NUMERIC'::character varying, 'DATE'::character varying, 'TIMESTAMP'::character varying, 'BOOLEAN'::character varying, 'JSONB'::character varying, 'BYTEA'::character varying])::text[])`,
    ),
    check(
      'ck_std_domain_cls_len',
      sql`review_yn OR ((col_type)::text <> ALL ((ARRAY['VARCHAR'::character varying, 'CHAR'::character varying, 'NUMERIC'::character varying])::text[])) OR (col_length IS NOT NULL)`,
    ),
  ],
);

export const stdDomain = pgTable(
  'std_domain',
  {
    domainId: integer('domain_id').primaryKey().generatedAlwaysAsIdentity({
      name: 'std_domain_domain_id_seq',
      startWith: 1,
      increment: 1,
      minValue: 1,
      maxValue: 2147483647,
      cache: 1,
    }),
    projectId: integer('project_id').notNull(),
    nm1: varchar({ length: 100 }).notNull(),
    nm2: varchar({ length: 100 }),
    nm3: varchar({ length: 100 }),
    nm4: varchar({ length: 100 }),
    nm5: varchar({ length: 100 }),
    nm6: varchar({ length: 100 }),
    nm7: varchar({ length: 100 }),
    logicalNm: varchar('logical_nm', { length: 200 }).notNull(),
    physicalNm: varchar('physical_nm', { length: 63 }),
    descr: varchar({ length: 500 }),
    suffix: varchar({ length: 30 }),
    domainClsId: integer('domain_cls_id'),
    colType: varchar('col_type', { length: 20 }),
    colLength: integer('col_length'),
    colScale: integer('col_scale'),
    typeSource: varchar('type_source', { length: 10 }).default('AUTO').notNull(),
    reviewYn: boolean('review_yn').default(false).notNull(),
    reviewNote: varchar('review_note', { length: 500 }),
    originProjectId: integer('origin_project_id'),
    originId: integer('origin_id'),
    createdAt: timestamp('created_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    createdBy: varchar('created_by', { length: 50 }).notNull(),
    createdIp: varchar('created_ip', { length: 45 }),
    updatedAt: timestamp('updated_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedBy: varchar('updated_by', { length: 50 }).notNull(),
    updatedIp: varchar('updated_ip', { length: 45 }),
  },
  (table) => [
    index('ix_std_domain_physical').using(
      'btree',
      table.projectId.asc().nullsLast().op('int4_ops'),
      table.physicalNm.asc().nullsLast().op('text_ops'),
    ),
    index('ix_std_domain_review')
      .using('btree', table.projectId.asc().nullsLast().op('int4_ops'))
      .where(sql`review_yn`),
    index('ix_std_domain_suffix').using(
      'btree',
      table.projectId.asc().nullsLast().op('text_ops'),
      table.suffix.asc().nullsLast().op('text_ops'),
    ),
    unique('uk_std_domain_pid').on(table.domainId, table.projectId),
    unique('uk_std_domain_logical').on(table.projectId, table.logicalNm),
    check(
      'ck_std_domain_type_source',
      sql`(type_source)::text = ANY ((ARRAY['AUTO'::character varying, 'MANUAL'::character varying])::text[])`,
    ),
    check(
      'ck_std_domain_physical_fmt',
      sql`(physical_nm IS NULL) OR ((physical_nm)::text ~ '^[A-Z0-9][A-Z0-9_]*$'::text)`,
    ),
    check(
      'ck_std_domain_type',
      sql`(col_type IS NULL) OR ((col_type)::text = ANY ((ARRAY['VARCHAR'::character varying, 'CHAR'::character varying, 'TEXT'::character varying, 'SMALLINT'::character varying, 'INT'::character varying, 'BIGINT'::character varying, 'NUMERIC'::character varying, 'DATE'::character varying, 'TIMESTAMP'::character varying, 'BOOLEAN'::character varying, 'JSONB'::character varying, 'BYTEA'::character varying])::text[]))`,
    ),
  ],
);

export const stdCodeCls = pgTable(
  'std_code_cls',
  {
    codeClsId: integer('code_cls_id').primaryKey().generatedAlwaysAsIdentity({
      name: 'std_code_cls_code_cls_id_seq',
      startWith: 1,
      increment: 1,
      minValue: 1,
      maxValue: 2147483647,
      cache: 1,
    }),
    projectId: integer('project_id').notNull(),
    bizAreaId: integer('biz_area_id').notNull(),
    codeCls: varchar('code_cls', { length: 10 }).notNull(),
    codeClsNm: varchar('code_cls_nm', { length: 100 }).notNull(),
    description: varchar({ length: 500 }),
    originProjectId: integer('origin_project_id'),
    originId: integer('origin_id'),
    createdAt: timestamp('created_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    createdBy: varchar('created_by', { length: 50 }).notNull(),
    createdIp: varchar('created_ip', { length: 45 }),
    updatedAt: timestamp('updated_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedBy: varchar('updated_by', { length: 50 }).notNull(),
    updatedIp: varchar('updated_ip', { length: 45 }),
  },
  (table) => [
    index('ix_std_code_cls_nm').using(
      'btree',
      table.projectId.asc().nullsLast().op('int4_ops'),
      table.codeClsNm.asc().nullsLast().op('text_ops'),
    ),
    unique('uk_std_code_cls_pid').on(table.codeClsId, table.projectId),
    unique('uk_std_code_cls').on(table.projectId, table.bizAreaId, table.codeCls),
  ],
);

export const stdCode = pgTable(
  'std_code',
  {
    codeId: integer('code_id').primaryKey().generatedAlwaysAsIdentity({
      name: 'std_code_code_id_seq',
      startWith: 1,
      increment: 1,
      minValue: 1,
      maxValue: 2147483647,
      cache: 1,
    }),
    projectId: integer('project_id').notNull(),
    codeClsId: integer('code_cls_id').notNull(),
    code: varchar({ length: 10 }).notNull(),
    codeNm: varchar('code_nm', { length: 100 }).notNull(),
    sortOrder: smallint('sort_order'),
    isActive: boolean('is_active').default(true).notNull(),
    originProjectId: integer('origin_project_id'),
    originId: integer('origin_id'),
    createdAt: timestamp('created_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    createdBy: varchar('created_by', { length: 50 }).notNull(),
    createdIp: varchar('created_ip', { length: 45 }),
    updatedAt: timestamp('updated_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedBy: varchar('updated_by', { length: 50 }).notNull(),
    updatedIp: varchar('updated_ip', { length: 45 }),
  },
  (table) => [unique('uk_std_code').on(table.codeClsId, table.code)],
);

export const stdDefaultColSet = pgTable(
  'std_default_col_set',
  {
    setId: integer('set_id').primaryKey().generatedAlwaysAsIdentity({
      name: 'std_default_col_set_set_id_seq',
      startWith: 1,
      increment: 1,
      minValue: 1,
      maxValue: 2147483647,
      cache: 1,
    }),
    projectId: integer('project_id').notNull(),
    setNm: varchar('set_nm', { length: 50 }).notNull(),
    description: varchar({ length: 200 }),
    isDefault: boolean('is_default').default(false).notNull(),
    originProjectId: integer('origin_project_id'),
    originId: integer('origin_id'),
    createdAt: timestamp('created_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    createdBy: varchar('created_by', { length: 50 }).notNull(),
    createdIp: varchar('created_ip', { length: 45 }),
    updatedAt: timestamp('updated_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedBy: varchar('updated_by', { length: 50 }).notNull(),
    updatedIp: varchar('updated_ip', { length: 45 }),
  },
  (table) => [
    uniqueIndex('ux_std_default_col_set_default')
      .using('btree', table.projectId.asc().nullsLast().op('int4_ops'))
      .where(sql`is_default`),
    unique('uk_std_default_col_set_pid').on(table.setId, table.projectId),
    unique('uk_std_default_col_set_nm').on(table.projectId, table.setNm),
  ],
);

export const stdDefaultCol = pgTable(
  'std_default_col',
  {
    defaultColId: integer('default_col_id').primaryKey().generatedAlwaysAsIdentity({
      name: 'std_default_col_default_col_id_seq',
      startWith: 1,
      increment: 1,
      minValue: 1,
      maxValue: 2147483647,
      cache: 1,
    }),
    projectId: integer('project_id').notNull(),
    setId: integer('set_id').notNull(),
    colSeq: smallint('col_seq').notNull(),
    logicalNm: varchar('logical_nm', { length: 100 }).notNull(),
    physicalNm: varchar('physical_nm', { length: 63 }).notNull(),
    isPk: boolean('is_pk').default(false).notNull(),
    dataType: varchar('data_type', { length: 20 }).notNull(),
    dataLength: integer('data_length'),
    dataScale: integer('data_scale'),
    isNullable: boolean('is_nullable').default(true).notNull(),
    defaultVal: varchar('default_val', { length: 200 }),
    colComment: varchar('col_comment', { length: 500 }),
    originProjectId: integer('origin_project_id'),
    originId: integer('origin_id'),
    createdAt: timestamp('created_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    createdBy: varchar('created_by', { length: 50 }).notNull(),
    createdIp: varchar('created_ip', { length: 45 }),
    updatedAt: timestamp('updated_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedBy: varchar('updated_by', { length: 50 }).notNull(),
    updatedIp: varchar('updated_ip', { length: 45 }),
  },
  (table) => [
    unique('uk_std_default_col_pid').on(table.defaultColId, table.projectId),
    unique('uk_std_default_col_seq').on(table.setId, table.colSeq),
    unique('uk_std_default_col_phys').on(table.setId, table.physicalNm),
    check('ck_std_default_col_phys_fmt', sql`(physical_nm)::text ~ '^[A-Z][A-Z0-9_]*$'::text`),
    check(
      'ck_std_default_col_type',
      sql`(data_type)::text = ANY ((ARRAY['VARCHAR'::character varying, 'CHAR'::character varying, 'TEXT'::character varying, 'SMALLINT'::character varying, 'INT'::character varying, 'BIGINT'::character varying, 'NUMERIC'::character varying, 'DATE'::character varying, 'TIMESTAMP'::character varying, 'BOOLEAN'::character varying, 'JSONB'::character varying, 'BYTEA'::character varying])::text[])`,
    ),
  ],
);

export const prjTable = pgTable(
  'prj_table',
  {
    tableId: integer('table_id').primaryKey().generatedAlwaysAsIdentity({
      name: 'prj_table_table_id_seq',
      startWith: 1,
      increment: 1,
      minValue: 1,
      maxValue: 2147483647,
      cache: 1,
    }),
    projectId: integer('project_id').notNull(),
    bizAreaId: integer('biz_area_id').notNull(),
    tableNm: varchar('table_nm', { length: 63 }).notNull(),
    tableLogicalNm: varchar('table_logical_nm', { length: 200 }).notNull(),
    description: text(),
    status: varchar({ length: 10 }).default('DRAFT').notNull(),
    version: integer().default(1).notNull(),
    finalizedAt: timestamp('finalized_at', { mode: 'string' }),
    finalizedBy: varchar('finalized_by', { length: 50 }),
    legacyTableId: varchar('legacy_table_id', { length: 50 }),
    reviewYn: boolean('review_yn').default(false).notNull(),
    reviewNote: varchar('review_note', { length: 500 }),
    createdAt: timestamp('created_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    createdBy: varchar('created_by', { length: 50 }).notNull(),
    createdIp: varchar('created_ip', { length: 45 }),
    updatedAt: timestamp('updated_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedBy: varchar('updated_by', { length: 50 }).notNull(),
    updatedIp: varchar('updated_ip', { length: 45 }),
  },
  (table) => [
    index('ix_prj_table_list').using(
      'btree',
      table.projectId.asc().nullsLast().op('timestamp_ops'),
      table.bizAreaId.asc().nullsLast().op('timestamp_ops'),
      table.status.asc().nullsLast().op('int4_ops'),
      table.updatedAt.desc().nullsFirst().op('timestamp_ops'),
    ),
    unique('uk_prj_table_pid').on(table.tableId, table.projectId),
    unique('uk_prj_table_nm').on(table.projectId, table.tableNm),
    check(
      'ck_prj_table_status',
      sql`(status)::text = ANY ((ARRAY['DRAFT'::character varying, 'FINAL'::character varying])::text[])`,
    ),
    check('ck_prj_table_nm_fmt', sql`(table_nm)::text ~ '^[A-Z][A-Z0-9_]*$'::text`),
  ],
);

export const prjColumn = pgTable(
  'prj_column',
  {
    columnId: integer('column_id').primaryKey().generatedAlwaysAsIdentity({
      name: 'prj_column_column_id_seq',
      startWith: 1,
      increment: 1,
      minValue: 1,
      maxValue: 2147483647,
      cache: 1,
    }),
    projectId: integer('project_id').notNull(),
    tableId: integer('table_id').notNull(),
    colSeq: smallint('col_seq').notNull(),
    logicalNm: varchar('logical_nm', { length: 200 }).notNull(),
    physicalNm: varchar('physical_nm', { length: 63 }).notNull(),
    isPk: boolean('is_pk').default(false).notNull(),
    dataType: varchar('data_type', { length: 20 }),
    dataLength: integer('data_length'),
    dataScale: integer('data_scale'),
    isNullable: boolean('is_nullable').default(true).notNull(),
    defaultVal: varchar('default_val', { length: 200 }),
    colComment: varchar('col_comment', { length: 500 }),
    domainId: integer('domain_id'),
    codeClsId: integer('code_cls_id'),
    defaultColId: integer('default_col_id'),
    matchType: varchar('match_type', { length: 12 }).default('MANUAL').notNull(),
    createdAt: timestamp('created_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    createdBy: varchar('created_by', { length: 50 }).notNull(),
    createdIp: varchar('created_ip', { length: 45 }),
    updatedAt: timestamp('updated_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedBy: varchar('updated_by', { length: 50 }).notNull(),
    updatedIp: varchar('updated_ip', { length: 45 }),
  },
  (table) => [
    index('ix_prj_column_code_cls').using(
      'btree',
      table.codeClsId.asc().nullsLast().op('int4_ops'),
    ),
    index('ix_prj_column_domain').using('btree', table.domainId.asc().nullsLast().op('int4_ops')),
    unique('uk_prj_column_seq').on(table.tableId, table.colSeq),
    unique('uk_prj_column_phys').on(table.tableId, table.physicalNm),
    check('ck_prj_column_pk_notnull', sql`(NOT is_pk) OR (NOT is_nullable)`),
    check('ck_prj_column_phys_fmt', sql`(physical_nm)::text ~ '^[A-Z][A-Z0-9_]*$'::text`),
    check(
      'ck_prj_column_type',
      sql`(data_type IS NULL) OR ((data_type)::text = ANY ((ARRAY['VARCHAR'::character varying, 'CHAR'::character varying, 'TEXT'::character varying, 'SMALLINT'::character varying, 'INT'::character varying, 'BIGINT'::character varying, 'NUMERIC'::character varying, 'DATE'::character varying, 'TIMESTAMP'::character varying, 'BOOLEAN'::character varying, 'JSONB'::character varying, 'BYTEA'::character varying])::text[]))`,
    ),
    check(
      'ck_prj_column_match',
      sql`(match_type)::text = ANY ((ARRAY['EXACT'::character varying, 'SIMILAR'::character varying, 'COMPOSED'::character varying, 'UNREGISTERED'::character varying, 'CODE'::character varying, 'DEFAULT'::character varying, 'MANUAL'::character varying])::text[])`,
    ),
  ],
);

export const prjTableHistory = pgTable(
  'prj_table_history',
  {
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    historyId: bigint('history_id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity({
      name: 'prj_table_history_history_id_seq',
      startWith: 1,
      increment: 1,
      minValue: 1,
      maxValue: 9223372036854775807,
      cache: 1,
    }),
    tableId: integer('table_id').notNull(),
    version: integer().notNull(),
    action: varchar({ length: 12 }).notNull(),
    changeSummary: varchar('change_summary', { length: 500 }),
    snapshot: jsonb().notNull(),
    savedBy: varchar('saved_by', { length: 50 }).notNull(),
    savedIp: varchar('saved_ip', { length: 45 }),
    savedAt: timestamp('saved_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    unique('uk_prj_table_history_ver').on(table.tableId, table.version),
    check(
      'ck_prj_table_history_action',
      sql`(action)::text = ANY ((ARRAY['CREATE'::character varying, 'UPDATE'::character varying, 'RESTORE'::character varying, 'FINALIZE'::character varying, 'UNFINALIZE'::character varying, 'CLONE'::character varying, 'MIGRATE'::character varying])::text[])`,
    ),
  ],
);

export const stdAuditLog = pgTable(
  'std_audit_log',
  {
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    auditId: bigint('audit_id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity({
      name: 'std_audit_log_audit_id_seq',
      startWith: 1,
      increment: 1,
      minValue: 1,
      maxValue: 9223372036854775807,
      cache: 1,
    }),
    projectId: integer('project_id').notNull(),
    entityType: varchar('entity_type', { length: 20 }).notNull(),
    entityId: integer('entity_id').notNull(),
    action: varchar({ length: 10 }).notNull(),
    beforeJson: jsonb('before_json'),
    afterJson: jsonb('after_json'),
    batchId: varchar('batch_id', { length: 36 }),
    actor: varchar({ length: 50 }).notNull(),
    actorIp: varchar('actor_ip', { length: 45 }),
    actedAt: timestamp('acted_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('ix_std_audit_log_entity').using(
      'btree',
      table.projectId.asc().nullsLast().op('int4_ops'),
      table.entityType.asc().nullsLast().op('int4_ops'),
      table.entityId.asc().nullsLast().op('text_ops'),
    ),
    index('ix_std_audit_log_time').using(
      'btree',
      table.projectId.asc().nullsLast().op('int4_ops'),
      table.actedAt.asc().nullsLast().op('timestamp_ops'),
    ),
    check(
      'ck_std_audit_log_entity',
      sql`(entity_type)::text = ANY ((ARRAY['BIZ_AREA'::character varying, 'TERM'::character varying, 'DOMAIN_CLS'::character varying, 'DOMAIN'::character varying, 'CODE_CLS'::character varying, 'CODE'::character varying, 'DEFAULT_COL_SET'::character varying, 'DEFAULT_COL'::character varying])::text[])`,
    ),
    check(
      'ck_std_audit_log_action',
      sql`(action)::text = ANY ((ARRAY['INSERT'::character varying, 'UPDATE'::character varying, 'DELETE'::character varying, 'APPROVE'::character varying, 'REJECT'::character varying, 'IMPORT'::character varying, 'COPY'::character varying])::text[])`,
    ),
  ],
);

export const ddlExportLog = pgTable(
  'ddl_export_log',
  {
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    exportId: bigint('export_id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity({
      name: 'ddl_export_log_export_id_seq',
      startWith: 1,
      increment: 1,
      minValue: 1,
      maxValue: 9223372036854775807,
      cache: 1,
    }),
    projectId: integer('project_id').notNull(),
    dialect: varchar({ length: 20 }).notNull(),
    outputKind: varchar('output_kind', { length: 10 }).notNull(),
    tableIds: jsonb('table_ids').notNull(),
    options: jsonb().notNull(),
    tableCnt: smallint('table_cnt').notNull(),
    warningCnt: smallint('warning_cnt').default(0).notNull(),
    exportedBy: varchar('exported_by', { length: 50 }).notNull(),
    exportedIp: varchar('exported_ip', { length: 45 }),
    exportedAt: timestamp('exported_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('ix_ddl_export_log_project').using(
      'btree',
      table.projectId.asc().nullsLast().op('int4_ops'),
      table.exportedAt.desc().nullsFirst().op('int4_ops'),
    ),
    check(
      'ck_ddl_export_log_kind',
      sql`(output_kind)::text = ANY ((ARRAY['COPY'::character varying, 'DOWNLOAD'::character varying, 'ZIP'::character varying, 'EXTRACT'::character varying])::text[])`,
    ),
  ],
);

export const projectCopyLog = pgTable(
  'project_copy_log',
  {
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    copyId: bigint('copy_id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity({
      name: 'project_copy_log_copy_id_seq',
      startWith: 1,
      increment: 1,
      minValue: 1,
      maxValue: 9223372036854775807,
      cache: 1,
    }),
    projectId: integer('project_id').notNull(),
    batchId: varchar('batch_id', { length: 36 }).notNull(),
    operation: varchar({ length: 10 }).notNull(),
    item: varchar({ length: 20 }).notNull(),
    sourceKind: varchar('source_kind', { length: 10 }).notNull(),
    sourceProjectId: integer('source_project_id'),
    options: jsonb().default({}).notNull(),
    sourceCnt: integer('source_cnt').default(0).notNull(),
    copiedCnt: integer('copied_cnt').default(0).notNull(),
    skippedCnt: integer('skipped_cnt').default(0).notNull(),
    flaggedCnt: integer('flagged_cnt').default(0).notNull(),
    warnings: jsonb().default([]).notNull(),
    elapsedMs: integer('elapsed_ms').default(0).notNull(),
    copiedBy: varchar('copied_by', { length: 50 }).notNull(),
    copiedAt: timestamp('copied_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('ix_project_copy_log_batch').using(
      'btree',
      table.projectId.asc().nullsLast().op('int4_ops'),
      table.batchId.asc().nullsLast().op('int4_ops'),
    ),
    check(
      'ck_project_copy_log_op',
      sql`(operation)::text = ANY ((ARRAY['CREATE'::character varying, 'PUBLISH'::character varying])::text[])`,
    ),
    check(
      'ck_project_copy_log_item',
      sql`(item)::text = ANY ((ARRAY['BIZ_AREA'::character varying, 'TERM'::character varying, 'DOMAIN_CLS'::character varying, 'DOMAIN'::character varying, 'CODE_CLS'::character varying, 'CODE'::character varying, 'DEFAULT_COL_SET'::character varying, 'DEFAULT_COL'::character varying])::text[])`,
    ),
    check(
      'ck_project_copy_log_source',
      sql`(source_kind)::text = ANY ((ARRAY['TEMPLATE'::character varying, 'PROJECT'::character varying, 'EMPTY'::character varying])::text[])`,
    ),
  ],
);

export const migrationLog = pgTable(
  'migration_log',
  {
    migrationId: integer('migration_id').primaryKey().generatedAlwaysAsIdentity({
      name: 'migration_log_migration_id_seq',
      startWith: 1,
      increment: 1,
      minValue: 1,
      maxValue: 2147483647,
      cache: 1,
    }),
    runId: varchar('run_id', { length: 36 }).notNull(),
    step: varchar({ length: 30 }).notNull(),
    ruleId: varchar('rule_id', { length: 5 }),
    sourceCnt: integer('source_cnt').default(0).notNull(),
    loadedCnt: integer('loaded_cnt').default(0).notNull(),
    excludedCnt: integer('excluded_cnt').default(0).notNull(),
    flaggedCnt: integer('flagged_cnt').default(0).notNull(),
    status: varchar({ length: 10 }).notNull(),
    message: text(),
    reportPath: varchar('report_path', { length: 200 }),
    startedAt: timestamp('started_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    finishedAt: timestamp('finished_at', { mode: 'string' }),
  },
  (table) => [
    index('ix_migration_log_run').using(
      'btree',
      table.runId.asc().nullsLast().op('text_ops'),
      table.step.asc().nullsLast().op('text_ops'),
    ),
    check(
      'ck_migration_log_status',
      sql`(status)::text = ANY ((ARRAY['SUCCESS'::character varying, 'FAILED'::character varying, 'SKIPPED'::character varying])::text[])`,
    ),
  ],
);

export const tfSession = pgTable(
  'tf_session',
  {
    sid: varchar().primaryKey().notNull(),
    sess: json().notNull(),
    expire: timestamp({ precision: 6, mode: 'string' }).notNull(),
  },
  (table) => [
    index('ix_tf_session_expire').using(
      'btree',
      table.expire.asc().nullsLast().op('timestamp_ops'),
    ),
  ],
);

export const tfProjectMember = pgTable(
  'tf_project_member',
  {
    projectId: integer('project_id').notNull(),
    userId: integer('user_id').notNull(),
    memberRole: varchar('member_role', { length: 10 }).notNull(),
    createdAt: timestamp('created_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    createdBy: varchar('created_by', { length: 50 }).notNull(),
    createdIp: varchar('created_ip', { length: 45 }),
    updatedAt: timestamp('updated_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedBy: varchar('updated_by', { length: 50 }).notNull(),
    updatedIp: varchar('updated_ip', { length: 45 }),
  },
  (table) => [
    index('ix_tf_project_member_user').using(
      'btree',
      table.userId.asc().nullsLast().op('int4_ops'),
    ),
    primaryKey({ columns: [table.projectId, table.userId], name: 'pk_tf_project_member' }),
    check(
      'ck_member_role',
      sql`(member_role)::text = ANY ((ARRAY['ADMIN'::character varying, 'EDITOR'::character varying, 'VIEWER'::character varying])::text[])`,
    ),
  ],
);
