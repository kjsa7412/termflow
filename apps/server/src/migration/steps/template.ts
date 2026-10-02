import { MIGRATION_AUDIT } from '../../common/audit/audit.js';
import { insertAudited } from '../../db/audit.js';
import { tfProject } from '../../db/schema.js';
import { findProjectId, STDV1, type StepDef } from '../context.js';

/** step 2 TEMPLATE(T3.7): tf_project STDV1(kind TEMPLATE, POSTGRESQL). */
export const templateStep: StepDef = {
  name: 'TEMPLATE',
  isDone: async ({ db }) => (await findProjectId(db, STDV1.key)) !== null,
  async run({ tx }) {
    await insertAudited(
      tx,
      tfProject,
      {
        projectKey: STDV1.key,
        projectNm: STDV1.nm,
        description: '승계 원본(dump-gen_table-new.sql)을 정제한 표준 템플릿',
        kind: 'TEMPLATE',
        status: 'ACTIVE',
        defaultDialect: 'POSTGRESQL',
      },
      MIGRATION_AUDIT,
    );
    return { source: 1, loaded: 1, excluded: 0, flagged: 0 };
  },
};
