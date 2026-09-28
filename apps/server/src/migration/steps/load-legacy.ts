import type { StepDef } from '../context.js';
import { LEGACY_TABLES, legacyExists, loadLegacy } from '../legacy-loader.js';

/** 설계서 §11.4 원본 열(legacy 건수 기대값). 건수가 다르면 적재 자체는 성공이어도 경고 메시지를 남긴다. */
export const LEGACY_EXPECTED = {
  tb_term_dict: 1705,
  tb_domain_cls: 54,
  tb_domain: 4587,
  tb_code_info: 991,
  tb_default_col: 9,
  tb_table_schema: 33,
  tb_column_schema: 649,
} as const;

/** step 1 LOAD_LEGACY(T3.3). 전용 연결·자체 트랜잭션이라 step 트랜잭션을 쓰지 않는다. */
export const loadLegacyStep: StepDef = {
  name: 'LOAD_LEGACY',
  transactional: false,
  isDone: ({ pool }) => legacyExists(pool),
  async run({ opts, log }) {
    const r = await loadLegacy(opts.connection, opts.dumpPath, opts.workDir);
    const total = LEGACY_TABLES.reduce((n, t) => n + r.counts[t], 0);
    const diff = LEGACY_TABLES.filter((t) => r.counts[t] !== LEGACY_EXPECTED[t]);
    log(`[migrate:seed]   legacy ${LEGACY_TABLES.map((t) => `${t}=${r.counts[t]}`).join(' ')}`);
    return {
      source: total,
      loaded: total,
      excluded: 0,
      flagged: 0,
      message:
        diff.length === 0
          ? `legacy 7 테이블 적재(기대 건수 일치): ${LEGACY_TABLES.map((t) => `${t}=${r.counts[t]}`).join(', ')}`
          : `기대 건수와 다름: ${diff.map((t) => `${t}=${r.counts[t]}(기대 ${LEGACY_EXPECTED[t]})`).join(', ')}`,
    };
  },
};
