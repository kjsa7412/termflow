import type { StepDef, StepName } from '../context.js';
import { bizAreaStep } from './biz-area.js';
import { codeStep } from './code.js';
import { defaultColStep } from './default-col.js';
import { domainClsStep } from './domain-cls.js';
import { domainStep } from './domain.js';
import { loadLegacyStep } from './load-legacy.js';
import { reconcileStep } from './reconcile.js';
import { templateStep } from './template.js';
import { termStep } from './term.js';

/** 단계 3에서 구현한 step(§11.1 1~8 + 11 1차 범위). 9·10은 단계 5, 12는 단계 7. */
export const STAGE3_STEPS: ReadonlyMap<StepName, StepDef> = new Map(
  [
    loadLegacyStep,
    templateStep,
    bizAreaStep,
    domainClsStep,
    termStep,
    domainStep,
    codeStep,
    defaultColStep,
    reconcileStep,
  ].map((s) => [s.name, s]),
);
