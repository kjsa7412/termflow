import { StepFailure, type StepDef } from '../context.js';
import { reconcileStdv1 } from '../reconciler.js';
import { RECONCILE_HEADER } from '../report-writer.js';

/**
 * step 11 RECONCILE(T3.13 1차 범위 → T5.11 전체 범위): legacy ↔ STDV1, RMS가 있으면 STDV1 ↔ RMS·테이블·컬럼 → `reconcile.csv`.
 * 읽기 전용 검증이라 선행 검사 없이 매번 실행한다. 불일치가 있으면 FAILED(러너 종료 코드 1).
 */
export const reconcileStep: StepDef = {
  name: 'RECONCILE',
  skippable: false,
  isDone: () => Promise.resolve(false),
  async run({ tx, report, log }) {
    const rows = await reconcileStdv1(tx);
    const path = report.writeTable(
      'reconcile',
      RECONCILE_HEADER,
      rows.map((r) => [
        r.item,
        r.legacyCnt,
        r.excludedCnt,
        r.stdv1Cnt,
        r.rmsCnt ?? 'N/A',
        r.flaggedCnt,
        r.check,
        r.result,
        r.note,
      ]),
    );
    const checked = rows.filter((r) => r.result !== 'N/A');
    const bad = checked.filter((r) => r.result === 'MISMATCH');
    for (const r of rows) {
      log(
        `[migrate:seed]   대사 ${r.item.padEnd(5)} 원본 ${String(r.legacyCnt).padStart(5)} = STDV1 ${String(r.stdv1Cnt).padStart(5)} + 제외 ${r.excludedCnt}` +
          ` · RMS ${r.rmsCnt === null ? 'N/A' : String(r.rmsCnt).padStart(5)} · 검토 ${r.flaggedCnt} → ${r.result}`,
      );
    }
    const result = {
      source: checked.reduce((n, r) => n + r.legacyCnt, 0),
      loaded: checked.reduce((n, r) => n + r.stdv1Cnt, 0),
      excluded: checked.reduce((n, r) => n + r.excludedCnt, 0),
      flagged: checked.reduce((n, r) => n + r.flaggedCnt, 0),
      message: `대사 ${checked.length}항목 중 불일치 ${bad.length} (${path})`,
    };
    if (bad.length > 0) {
      throw new StepFailure(`대사 불일치: ${bad.map((b) => b.item).join(', ')}`, result);
    }
    return result;
  },
};
