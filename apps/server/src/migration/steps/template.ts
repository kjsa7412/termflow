import { MIGRATION_AUDIT } from '../../common/audit/audit.js';
import { insertAudited } from '../../db/audit.js';
import { tfProject } from '../../db/schema.js';
import { findProjectId, SEED_TEMPLATE, type StepDef } from '../context.js';

/** step 2 TEMPLATE(T3.7): tf_project RETAILV1(kind TEMPLATE, POSTGRESQL). */
export const templateStep: StepDef = {
  name: 'TEMPLATE',
  isDone: async ({ db }) => (await findProjectId(db, SEED_TEMPLATE.key)) !== null,
  async run({ tx }) {
    await insertAudited(
      tx,
      tfProject,
      {
        projectKey: SEED_TEMPLATE.key,
        projectNm: SEED_TEMPLATE.nm,
        description: SEED_TEMPLATE.description,
        kind: 'TEMPLATE',
        status: 'ACTIVE',
        defaultDialect: 'POSTGRESQL',
      },
      MIGRATION_AUDIT,
    );
    return { source: 1, loaded: 1, excluded: 0, flagged: 0 };
  },
};
