import type pg from 'pg';
import { createDb } from '../../db/client.js';
import { prepareTemplates } from './builtin-template.js';

/**
 * 앱 기동·러너 CLI 공용 진입점(CR-16 C4). 템플릿 준비가 실패해도 서비스 기동·승계는 막지 않는다 —
 * 오류를 남기고 다음 기동 때 다시 시도한다(적재는 한 트랜잭션이라 부분 생성이 없다).
 */
export async function prepareTemplatesSafely(
  pool: pg.Pool,
  log: (m: string) => void,
): Promise<void> {
  try {
    await prepareTemplates(createDb(pool), log);
  } catch (error) {
    log(
      `기본 표준 템플릿 준비 실패(다음 기동 때 다시 시도): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
