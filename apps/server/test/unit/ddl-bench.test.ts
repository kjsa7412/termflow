import { describe, expect, it } from 'vitest';
import { DDL_OPTIONS_DEFAULT, ddlOptionsSchema } from '@termflow/shared';
import { dialectFor } from '../../src/ddl/dialects.js';
import { extractTables } from '../../src/ddl/extractor.js';
import { generateBundle } from '../../src/ddl/generator.js';
import { validateTable } from '../../src/ddl/validator.js';
import { GOLDEN_META, rp33Models } from './rp33.js';

/**
 * T7.13 성능(설계서 §12.1 "DDL 생성: 33 테이블 1초 이내"): 검증 + SINGLE·PER_TABLE 생성 + 정보 추출을 20회 반복해
 * 1회 시간(중앙값·최대)을 기록한다. 순수 렌더링만 잰다(DB 조회·HTTP는 `test:db -- ddl`의 API 측정).
 * (Vitest 5는 `bench()` 전역 API가 바뀌어 반복 측정을 이 테스트 안에서 직접 한다 — CR-06.)
 */
describe('DDL 생성 성능 — RMS 33 테이블', () => {
  it('33 테이블 생성(검증 + SINGLE + PER_TABLE + 정보 추출) 1초 이내', () => {
    const pg = dialectFor('POSTGRESQL');
    const rp = rp33Models();
    const opts = ddlOptionsSchema.parse({ codeColumnStyle: 'CHECK', dropIfExists: true });
    const run = () => {
      const inputs = rp.models.map((model) => ({
        model,
        warnings: validateTable(model, { dialect: 'POSTGRESQL', suffixes: rp.suffixes }).warnings,
      }));
      const b = generateBundle(pg, inputs, opts, GOLDEN_META);
      const x = extractTables(pg, rp.models, DDL_OPTIONS_DEFAULT);
      return b.sql.length + b.perTableFiles.length + x.rowCnt;
    };
    run(); // 워밍업(YAML·예약어 로드)
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      expect(run()).toBeGreaterThan(0);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[10]!;
    const max = times[times.length - 1]!;
    console.log(
      `[bench] DDL 33 테이블(649 컬럼) 생성 1회: 중앙값 ${median.toFixed(1)}ms · 최대 ${max.toFixed(1)}ms (20회)`,
    );
    expect(max).toBeLessThan(1000);
  });
});
