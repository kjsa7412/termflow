import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  AUDIT_ACTIONS,
  COPY_OPERATIONS,
  COPY_SOURCE_KINDS,
  DDL_OUTPUT_KINDS,
  DIALECTS,
  HISTORY_ACTIONS,
  MATCH_TYPES,
  MEMBER_ROLES,
  MIGRATION_STATUSES,
  PROJECT_KINDS,
  PROJECT_STATUSES,
  STD_ENTITY_TYPES,
  STD_TYPES,
  STD_TYPES_LENGTH_REQUIRED,
  TABLE_STATUSES,
  TERM_STATUSES,
  TYPE_SOURCES,
} from '@termflow/shared';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../../src/db/migrate.js';

// T2.9 DoD: 부록 A(0001_baseline.sql)의 CHECK IN 값과 shared enum 값이 일치한다.
const sqlText = readFileSync(path.join(MIGRATIONS_FOLDER, '0001_baseline.sql'), 'utf8');

/** `CONSTRAINT <name> CHECK (… IN ('A','B'))`의 값 목록. */
function checkValues(name: string): string[] {
  const re = new RegExp(`CONSTRAINT ${name} CHECK \\(([^;]*?)\\)\\s*(,|\\n\\))`, 's');
  const m = re.exec(sqlText);
  if (!m) throw new Error(`CHECK 제약 없음: ${name}`);
  const inList = /IN \(([^)]*)\)/.exec(m[1]!);
  if (!inList) throw new Error(`IN 목록 없음: ${name}`);
  return [...inList[1]!.matchAll(/'([^']*)'/g)].map((x) => x[1]!);
}

const cases: [string, readonly string[]][] = [
  ['ck_tf_project_kind', PROJECT_KINDS],
  ['ck_tf_project_status', PROJECT_STATUSES],
  ['ck_tf_project_dialect', DIALECTS],
  ['ck_member_role', MEMBER_ROLES],
  ['ck_std_term_status', TERM_STATUSES],
  ['ck_std_domain_cls_type', STD_TYPES],
  // 길이 필수 타입(NOT IN 목록, E_TYPE_LEN_MISSING과 같은 집합)
  ['ck_std_domain_cls_len', STD_TYPES_LENGTH_REQUIRED],
  ['ck_std_domain_type_source', TYPE_SOURCES],
  ['ck_std_domain_type', STD_TYPES],
  ['ck_std_default_col_type', STD_TYPES],
  ['ck_prj_table_status', TABLE_STATUSES],
  ['ck_prj_column_type', STD_TYPES],
  ['ck_prj_column_match', MATCH_TYPES],
  ['ck_prj_table_history_action', HISTORY_ACTIONS],
  ['ck_std_audit_log_entity', STD_ENTITY_TYPES],
  ['ck_std_audit_log_action', AUDIT_ACTIONS],
  ['ck_ddl_export_log_kind', DDL_OUTPUT_KINDS],
  ['ck_project_copy_log_op', COPY_OPERATIONS],
  ['ck_project_copy_log_item', STD_ENTITY_TYPES],
  ['ck_project_copy_log_source', COPY_SOURCE_KINDS],
  ['ck_migration_log_status', MIGRATION_STATUSES],
];

describe('shared enum ↔ 0001_baseline.sql CHECK (T2.9)', () => {
  it.each(cases)('%s', (name, values) => {
    expect([...values].sort()).toEqual(checkValues(name).sort());
  });

  it('IN 목록을 가진 CHECK 제약을 빠짐없이 대조한다', () => {
    const all = [...sqlText.matchAll(/CONSTRAINT (ck_\w+) CHECK \([^;\n]*\bIN \(/g)].map(
      (m) => m[1],
    );
    expect(all.sort()).toEqual(cases.map((c) => c[0]).sort());
  });
});
