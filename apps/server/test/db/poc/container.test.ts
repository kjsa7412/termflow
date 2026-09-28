import pg from 'pg';
import { describe, expect, inject, it } from 'vitest';

// T1.1 Testcontainers 기반 확인: 기동(globalSetup) → 연결 → 종료(teardown)
describe('poc/container', () => {
  it('postgres:17 컨테이너에 연결되고 버전·타임존이 맞다', async () => {
    const client = new pg.Client({ connectionString: inject('pgAdminUrl') });
    await client.connect();
    const { rows } = await client.query<{ v: string; tz: string }>(
      "select current_setting('server_version') as v, current_setting('TimeZone') as tz",
    );
    await client.end();
    expect(rows[0]?.v).toMatch(/^17\./);
    console.log(
      `[poc/container] server_version=${rows[0]?.v} TimeZone=${rows[0]?.tz} 기동=${inject('pgStartMs')}ms`,
    );
  });
});
