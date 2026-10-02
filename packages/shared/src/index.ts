/**
 * @termflow/shared — 서버·웹이 함께 import하는 상수·타입·zod 스키마·검증 코드표(설계서 §2.5.1).
 */
export const APP_NAME = 'TermFlow';

/** `/health` 응답의 status 값(@nestjs/terminus 형식). */
export const HEALTH_STATUS = {
  OK: 'ok',
  ERROR: 'error',
  SHUTTING_DOWN: 'shutting_down',
} as const;

export type HealthStatus = (typeof HEALTH_STATUS)[keyof typeof HEALTH_STATUS];

export interface HealthResponse {
  status: HealthStatus;
}

/** 업무 API 경로 접두어(설계서 §5.4 등). `/health`는 접두어 밖에 둔다. */
export const API_PREFIX = '/api/v1';

export * from './enums.js';
export * from './limits.js';
export * from './text/josa.js';
export * from './validation/codes.js';
export * from './validation/identifier.js';
export * from './validation/password.js';
export * from './validation/std-type.js';
export * from './validation/standard.js';
export * from './api/problem.js';
export * from './api/types.js';
export * from './schemas/common.js';
export * from './schemas/table.js';
export * from './schemas/term.js';
export * from './schemas/domain-cls.js';
export * from './schemas/domain.js';
export * from './schemas/code.js';
export * from './schemas/default-col.js';
export * from './schemas/biz-area.js';
export * from './schemas/standard.js';
export * from './schemas/member.js';
export * from './schemas/project.js';
export * from './schemas/user.js';
export * from './schemas/autocomplete.js';
export * from './schemas/ddl-options.js';
