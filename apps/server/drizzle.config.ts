import { defineConfig } from 'drizzle-kit';

// SQL 파일이 진실(설계서 §2.5.3). generate는 `--custom`(빈 SQL 파일)만 쓰고 diff generate는 쓰지 않는다.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env['TERMFLOW_DB_URL_WITH_AUTH'] ?? 'postgres://termflow@localhost:7341/termflow',
  },
});
