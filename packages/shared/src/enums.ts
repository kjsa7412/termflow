/**
 * 상태·분류 값(설계서 §2.5.1, 부록 A의 CHECK 값과 1:1). 값을 바꾸면 SQL 마이그레이션과 함께 바꾼다.
 * 일치 여부는 서버 테스트(test/unit/enums-vs-sql.test.ts)가 0001_baseline.sql을 파싱해 검사한다.
 */
function values<const T extends readonly string[]>(...v: T): T {
  return v;
}

/** 표준 타입 12종(§6.3). */
export const STD_TYPES = values(
  'VARCHAR',
  'CHAR',
  'TEXT',
  'SMALLINT',
  'INT',
  'BIGINT',
  'NUMERIC',
  'DATE',
  'TIMESTAMP',
  'BOOLEAN',
  'JSONB',
  'BYTEA',
);
export type StdType = (typeof STD_TYPES)[number];
/** 길이(정밀도)가 필수인 타입(E_TYPE_LEN_MISSING). */
export const STD_TYPES_LENGTH_REQUIRED = values('VARCHAR', 'CHAR', 'NUMERIC');

export const DIALECTS = values('POSTGRESQL', 'ORACLE', 'MYSQL');
export type Dialect = (typeof DIALECTS)[number];

export const TERM_STATUSES = values('APPROVED', 'PENDING', 'REJECTED');
export type TermStatus = (typeof TERM_STATUSES)[number];

export const MATCH_TYPES = values(
  'EXACT',
  'SIMILAR',
  'COMPOSED',
  'UNREGISTERED',
  'CODE',
  'DEFAULT',
  'MANUAL',
);
export type MatchType = (typeof MATCH_TYPES)[number];

export const TABLE_STATUSES = values('DRAFT', 'FINAL');
export type TableStatus = (typeof TABLE_STATUSES)[number];

/** 프로젝트 멤버 역할(권한 순서 VIEWER < EDITOR < ADMIN, §7.2). */
export const MEMBER_ROLES = values('ADMIN', 'EDITOR', 'VIEWER');
export type MemberRole = (typeof MEMBER_ROLES)[number];
export const MEMBER_ROLE_RANK: Record<MemberRole, number> = { VIEWER: 1, EDITOR: 2, ADMIN: 3 };

export const PROJECT_KINDS = values('PROJECT', 'TEMPLATE');
export type ProjectKind = (typeof PROJECT_KINDS)[number];

export const PROJECT_STATUSES = values('ACTIVE', 'ARCHIVED');
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** 도메인 타입 출처: AUTO(접미어 규칙) / MANUAL(수기, 재계산 시 유지). */
export const TYPE_SOURCES = values('AUTO', 'MANUAL');
export type TypeSource = (typeof TYPE_SOURCES)[number];

export const HISTORY_ACTIONS = values(
  'CREATE',
  'UPDATE',
  'RESTORE',
  'FINALIZE',
  'UNFINALIZE',
  'CLONE',
  'MIGRATE',
);
export type HistoryAction = (typeof HISTORY_ACTIONS)[number];

/** 감사·복사 대상 항목(std_audit_log.entity_type = project_copy_log.item). */
export const STD_ENTITY_TYPES = values(
  'BIZ_AREA',
  'TERM',
  'DOMAIN_CLS',
  'DOMAIN',
  'CODE_CLS',
  'CODE',
  'DEFAULT_COL_SET',
  'DEFAULT_COL',
);
export type StdEntityType = (typeof STD_ENTITY_TYPES)[number];

export const AUDIT_ACTIONS = values(
  'INSERT',
  'UPDATE',
  'DELETE',
  'APPROVE',
  'REJECT',
  'IMPORT',
  'COPY',
);
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const DDL_OUTPUT_KINDS = values('COPY', 'DOWNLOAD', 'ZIP', 'EXTRACT');
export type DdlOutputKind = (typeof DDL_OUTPUT_KINDS)[number];

export const COPY_OPERATIONS = values('CREATE', 'PUBLISH');
export type CopyOperation = (typeof COPY_OPERATIONS)[number];

export const COPY_SOURCE_KINDS = values('TEMPLATE', 'PROJECT', 'EMPTY');
export type CopySourceKind = (typeof COPY_SOURCE_KINDS)[number];

export const MIGRATION_STATUSES = values('SUCCESS', 'FAILED', 'SKIPPED');
export type MigrationStatus = (typeof MIGRATION_STATUSES)[number];

/** 감사 주체: 로그인 사용자 외 시스템 주체(§7.5 부트스트랩 SYSTEM, §11.1 승계 MIGRATION). */
export const SYSTEM_ACTORS = { SYSTEM: 'SYSTEM', MIGRATION: 'MIGRATION' } as const;
