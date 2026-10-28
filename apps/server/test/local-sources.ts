import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 저장소에 올리지 않고 개발 PC에만 두는 원천(.gitignore). 승계 원본 dump·설계서·CR-09 전환 스크립트를 읽는 테스트는
 * 파일이 없으면(CI·새 clone) 건너뛰고, 있는 개발 PC의 로컬 게이트에서만 돈다.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export const LEGACY_DUMP = path.join(ROOT, 'seed', 'original', 'dump-gen_table-new.sql');
export const DESIGN_DOC = path.join(ROOT, 'docs', '02_설계서.md');
export const CR09_SQL = path.join(ROOT, 'docs', 'cr09_rename_postgresql.sql');

export const HAS_LEGACY_DUMP = existsSync(LEGACY_DUMP);
export const HAS_DESIGN_DOC = existsSync(DESIGN_DOC);

/** 승계 원본 dump로 RETAILV1·RMS를 만들어 쓰는 test:db 파일(vitest.db.config 상대 경로). */
export const LEGACY_DUMP_DB_TESTS = [
  'test/db/migration.test.ts',
  'test/db/migration-rms.test.ts',
  'test/db/autocomplete-rms.test.ts',
  'test/db/copy.test.ts',
  'test/db/ddl-regression.test.ts',
  'test/db/standard-stdv1.test.ts',
  'test/db/term-unify.test.ts',
];
