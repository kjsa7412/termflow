import { sql } from 'drizzle-orm';
import { rowsOf } from '../../project/sql-util.js';
import { loadTableModels } from '../../table/table-model.loader.js';
import { findProjectId, RMS, StepFailure, type StepDef } from '../context.js';
import { regressionCases, runDdlRegression, syntheticCases } from '../ddl-regression.js';

export const DDL_REGRESSION_HEADER = [
  'set',
  'table_nm',
  'columns',
  'result',
  'error',
  'mismatches',
] as const;

/**
 * step 12 DDL_REGRESSION(T7.11, 설계서 §11.1·§6.12, G3): RMS 33 테이블 DDL을 기본 옵션(D15)과 `dropIfExists + CHECK`로 생성해
 * PostgreSQL에서 실행하고 카탈로그로 대조한다 + 합성(이스케이프·예약어 인용) 테이블. 임시 스키마·한 트랜잭션·ROLLBACK
 * (`ddl-regression.ts`) — 아무것도 남기지 않으므로 선행 검사 없이 매번 실행한다. 실패·불일치가 1건이라도 있으면 FAILED.
 * 리포트 `ddl_regression.csv`(옵션 세트 × 테이블 1행).
 */
export const ddlRegressionStep: StepDef = {
  name: 'DDL_REGRESSION',
  skippable: false,
  transactional: false,
  isDone: () => Promise.resolve(false),
  async run({ db, pool, report, log }) {
    const rmsId = await findProjectId(db, RMS.key);
    if (rmsId === null) throw new StepFailure('RMS가 없습니다 — 먼저 COPY_TO_RMS·TABLE step을 실행하십시오');
    const ids = await rowsOf<{ table_id: number }>(
      db,
      sql`select table_id from prj_table where project_id = ${rmsId} order by table_nm collate "C"`,
    );
    const models = await loadTableModels(
      db,
      rmsId,
      ids.map((r) => r.table_id),
    );
    if (models.length === 0) throw new StepFailure('RMS에 테이블이 없습니다 — 먼저 TABLE step을 실행하십시오');

    const client = await pool.connect();
    let results;
    try {
      results = await runDdlRegression(client, [...regressionCases(models), ...syntheticCases()]);
    } finally {
      client.release();
    }
    const path = report.writeTable(
      'ddl_regression',
      DDL_REGRESSION_HEADER,
      results.map((r) => [
        r.set,
        r.tableNm,
        r.columns,
        r.ok ? 'OK' : 'FAIL',
        r.error,
        r.mismatches.join(' | '),
      ]),
    );
    const bySet = new Map<string, { n: number; ok: number }>();
    for (const r of results) {
      const s = bySet.get(r.set) ?? { n: 0, ok: 0 };
      s.n++;
      if (r.ok) s.ok++;
      bySet.set(r.set, s);
    }
    const summary = [...bySet].map(([set, s]) => `${set} ${s.ok}/${s.n}`).join(' · ');
    const bad = results.filter((r) => !r.ok);
    const mismatches = results.reduce((n, r) => n + r.mismatches.length, 0);
    for (const b of bad.slice(0, 10)) {
      log(`[migrate:seed]   DDL 실패 ${b.set} ${b.tableNm}: ${b.error ?? b.mismatches.slice(0, 3).join(' | ')}`);
    }
    const def = bySet.get('default') ?? { n: 0, ok: 0 };
    // migration_log.rule_id VARCHAR(5): G3(기본) · G3CK(dropIfExists+CHECK) · SYNTH(합성 전체)
    const ruleOf = (set: string) =>
      set === 'default' ? 'G3' : set === 'drop-check' ? 'G3CK' : 'SYNTH';
    const rules = new Map<string, { rule: string; source: number; loaded: number; excluded: number; flagged: number }>();
    for (const [set, s] of bySet) {
      const k = ruleOf(set);
      const r = rules.get(k) ?? { rule: k, source: 0, loaded: 0, excluded: 0, flagged: 0 };
      r.source += s.n;
      r.loaded += s.ok;
      r.flagged += s.n - s.ok;
      rules.set(k, r);
    }
    const result = {
      source: models.length,
      loaded: def.ok,
      excluded: 0,
      flagged: bad.length,
      rules: [...rules.values()],
      message: `실행 성공 ${summary} · 대조 불일치 ${mismatches} (${path})`,
    };
    if (bad.length > 0) throw new StepFailure(`DDL 회귀 실패 ${bad.length}건: ${summary}`, result);
    return result;
  },
};
