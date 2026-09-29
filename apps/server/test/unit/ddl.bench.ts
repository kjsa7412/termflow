import { bench, describe } from 'vitest';
import { ddlOptionsSchema } from '@termflow/shared';
import { dialectFor } from '../../src/ddl/dialects.js';
import { generateBundle } from '../../src/ddl/generator.js';
import { validateTable } from '../../src/ddl/validator.js';
import { GOLDEN_META, rp33Models } from './rp33.js';

// T7.13: `pnpm --filter @termflow/server exec vitest bench` — RMS 33 테이블 검증 + 생성(§12.1 1초 이내)
const pg = dialectFor('POSTGRESQL');
const rp = rp33Models();
const opts = ddlOptionsSchema.parse({});

describe('DDL 생성', () => {
  bench('RMS 33 테이블 검증 + SINGLE/PER_TABLE 생성', () => {
    const inputs = rp.models.map((model) => ({
      model,
      warnings: validateTable(model, { dialect: 'POSTGRESQL', suffixes: rp.suffixes }).warnings,
    }));
    generateBundle(pg, inputs, opts, GOLDEN_META);
  });
});
