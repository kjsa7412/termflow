import type { StepDef, StepName } from '../context.js';
import { bizAreaStep } from './biz-area.js';
import { codeStep } from './code.js';
import { copyToRmsStep } from './copy-to-rms.js';
import { defaultColStep } from './default-col.js';
import { domainClsStep } from './domain-cls.js';
import { domainStep } from './domain.js';
import { loadLegacyStep } from './load-legacy.js';
import { reconcileStep } from './reconcile.js';
import { tableStep } from './table.js';
import { templateStep } from './template.js';
import { termStep } from './term.js';

/** 구현된 step(§11.1 1~11). 12 DDL_REGRESSION은 단계 7(DDL 엔진). */
export const SEED_STEPS: ReadonlyMap<StepName, StepDef> = new Map(
  [
    loadLegacyStep,
    templateStep,
    bizAreaStep,
    domainClsStep,
    termStep,
    domainStep,
    codeStep,
    defaultColStep,
    copyToRmsStep,
    tableStep,
    reconcileStep,
  ].map((s) => [s.name, s]),
);
