/**
 * @termflow/shared — 서버·웹이 함께 import하는 상수·타입.
 * 단계 2에서 api/·schemas/·validation/·enums.ts가 추가된다(설계서 §2.5.1).
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
