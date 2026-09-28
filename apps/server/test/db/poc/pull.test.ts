import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/db/migrate.js';
import { createDatabase } from '../setup/databases.js';
// @ts-expect-error -- 타입 선언 없는 .mjs 스크립트
import { postprocessSchema } from '../../../scripts/pull-postprocess.mjs';

// T1.4 drizzle-kit pull → schema.ts 역생성, 표현 확인, casing·격리 수준
const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '../../..');
const outDir = path.join(here, '.pull'); // gitignore

describe('poc/pull (T1.4)', () => {
  let pool: pg.Pool;
  let url: string;

  beforeAll(async () => {
    url = await createDatabase('poc_pull');
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
    rmSync(outDir, { recursive: true, force: true });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('drizzle-kit pull 원본은 strict tsc 실패(순환 FK TS7022), 후처리본은 타입 오류 없이 컴파일된다', () => {
    const kitBin = path.join(serverRoot, 'node_modules', 'drizzle-kit', 'bin.cjs');
    const t0 = performance.now();
    const res = spawnSync(
      process.execPath,
      [kitBin, 'pull', '--dialect=postgresql', `--url=${url}`, `--out=${outDir}`],
      { cwd: serverRoot, encoding: 'utf8' },
    );
    console.log(`[poc/pull] drizzle-kit pull ${Math.round(performance.now() - t0)}ms`);
    if (res.status !== 0) console.error(res.stdout, res.stderr);
    expect(res.status).toBe(0);
    expect(existsSync(path.join(outDir, 'schema.ts'))).toBe(true);
    expect(existsSync(path.join(outDir, 'relations.ts'))).toBe(true);
    // pull은 out 폴더에 0000_*.sql·meta/_journal.json도 만든다 → 마이그레이션 폴더(drizzle/)를 out으로 쓰면 안 된다
    expect(existsSync(path.join(outDir, 'meta', '_journal.json'))).toBe(true);

    const tscBin = path.join(serverRoot, 'node_modules', 'typescript', 'bin', 'tsc');
    const compile = (file: string) => {
      const cfg = path.join(outDir, `tsconfig.${file}.json`);
      writeFileSync(
        cfg,
        JSON.stringify({
          extends: '../../../../tsconfig.json',
          compilerOptions: { noEmit: true, rootDir: '.' },
          include: [file],
        }),
      );
      return spawnSync(process.execPath, [tscBin, '-p', cfg], {
        cwd: serverRoot,
        encoding: 'utf8',
      });
    };

    const raw = compile('schema.ts');
    const rawErrors = raw.stdout.match(/error TS\d+/g) ?? [];
    console.log(
      `[poc/pull] 원본 schema.ts tsc 오류 ${rawErrors.length}건: ${[...new Set(rawErrors)].join(',')}`,
    );
    expect(raw.status).not.toBe(0);

    writeFileSync(
      path.join(outDir, 'schema.pp.ts'),
      postprocessSchema(readFileSync(path.join(outDir, 'schema.ts'), 'utf8')),
    );
    const pp = compile('schema.pp.ts');
    if (pp.status !== 0) console.error(pp.stdout);
    expect(pp.status).toBe(0);
  });

  it('pull 산출물의 표현 범위를 기록한다(복합 FK·CHECK·IDENTITY·부분 인덱스·DEFERRABLE)', () => {
    const schema = readFileSync(path.join(outDir, 'schema.ts'), 'utf8');
    const report = {
      tables: (schema.match(/= pgTable\(/g) ?? []).length,
      identity: /generatedAlwaysAsIdentity\(/.test(schema),
      check: /check\("ck_prj_column_match"/.test(schema),
      compositeFk: /foreignKey\(\{\s*columns: \[table\.projectId, table\.domainClsId\]/.test(
        schema,
      ),
      setNullColumnList: /set null \(domain_cls_id\)|SET NULL \(domain_cls_id\)/i.test(schema),
      partialIndex: /\.where\(sql`/.test(schema),
      uniqueConstraint: /unique\("uk_prj_column_seq"\)/.test(schema),
      deferrable: /deferrable|DEFERRABLE/.test(schema),
      // 복합 FK 참조 열 순서가 뒤바뀌어 나온다(SQL은 (project_id, domain_id) → (project_id, domain_id))
      compositeFkOrderSwapped:
        /columns: \[table\.projectId, table\.domainId\],\s*foreignColumns: \[stdDomain\.domainId, stdDomain\.projectId\]/.test(
          schema,
        ),
    };
    console.log(`[poc/pull] 표현 확인 ${JSON.stringify(report)}`);
    writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    expect(report.tables).toBe(19);
    expect(report.identity).toBe(true);
    expect(report.check).toBe(true);
    expect(report.compositeFk).toBe(true);
    expect(report.partialIndex).toBe(true);
    expect(report.uniqueConstraint).toBe(true);
  });

  it("casing: 'snake_case'로 insert·select 1건, repeatable read 트랜잭션 격리 지정", async () => {
    const schema = (await import(pathToFileURL(path.join(outDir, 'schema.pp.ts')).href)) as Record<
      string,
      unknown
    >;
    const db = drizzle(pool, { schema, casing: 'snake_case' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 런타임 생성 모듈
    const tfUser = schema['tfUser'] as any;
    await db.insert(tfUser).values({
      loginId: 'poc',
      userNm: 'PoC 사용자',
      passwordHash: 'x',
      createdBy: 'SYSTEM',
      updatedBy: 'SYSTEM',
    });
    const rows = (await db.select().from(tfUser).where(eq(tfUser.loginId, 'poc'))) as {
      userId: number;
      isSysAdmin: boolean;
      pwChangeRequired: boolean;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isSysAdmin).toBe(false);
    expect(rows[0]?.pwChangeRequired).toBe(true);

    const level = await db.transaction(
      async (tx) => {
        const r = await tx.execute<{ lvl: string }>(
          sql`select current_setting('transaction_isolation') as lvl`,
        );
        return r.rows[0]?.lvl;
      },
      { isolationLevel: 'repeatable read' },
    );
    expect(level).toBe('repeatable read');
  });
});
