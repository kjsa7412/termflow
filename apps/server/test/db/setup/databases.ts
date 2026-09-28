import pg from 'pg';
import { inject } from 'vitest';

/** 컨테이너 관리 DB(termflow) 접속 URL에서 DB 이름만 바꾼다. */
export function dbUrl(database: string): string {
  const url = new URL(inject('pgAdminUrl'));
  url.pathname = `/${database}`;
  return url.toString();
}

/** 테스트 파일마다 격리된 빈 DB를 만든다(이미 있으면 지우고 다시 만든다). */
export async function createDatabase(database: string, template?: string): Promise<string> {
  if (!/^[a-z][a-z0-9_]*$/.test(database)) throw new Error(`잘못된 DB 이름: ${database}`);
  const admin = new pg.Client({ connectionString: inject('pgAdminUrl') });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${database}${template ? ` TEMPLATE ${template}` : ''}`);
  } finally {
    await admin.end();
  }
  return dbUrl(database);
}
