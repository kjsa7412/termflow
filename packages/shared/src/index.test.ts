import { describe, expect, it } from 'vitest';
import { API_PREFIX, APP_NAME, HEALTH_STATUS } from './index.js';

describe('@termflow/shared', () => {
  it('앱 이름과 헬스 상태 상수를 노출한다', () => {
    expect(APP_NAME).toBe('TermFlow');
    expect(HEALTH_STATUS.OK).toBe('ok');
    expect(API_PREFIX).toBe('/api/v1');
  });
});
