import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleModels, type ModelRows, type TableRow } from '../../src/ddl/assemble.js';
import type { DdlMeta, TableModel } from '../../src/ddl/model.js';

/**
 * `test/seed/rp33.sql`(승계 완료 스냅샷)의 JSON 행을 읽어 DB 없이 TableModel을 만든다(골든 파일 단위 테스트).
 * DB 테스트는 같은 파일을 그대로 실행한다(`loadRp33`).
 */
export const RP33_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../seed/rp33.sql',
);

export function rp33Sql(): string {
  return readFileSync(RP33_PATH, 'utf8');
}

export function parseSnapshot(text: string): Map<string, Record<string, unknown>[]> {
  const out = new Map<string, Record<string, unknown>[]>();
  const re = /json_populate_recordset\(NULL::(\w+), \$json\$([\s\S]*?)\$json\$\)/g;
  for (const m of text.matchAll(re)) {
    out.set(m[1]!, JSON.parse(m[2]!) as Record<string, unknown>[]);
  }
  return out;
}

export interface Rp33 {
  models: TableModel[];
  suffixes: Set<string>;
  project: { projectKey: string; projectNm: string; defaultDialect: string };
}

/** 스냅샷 → 모델(물리명 오름차순). */
export function rp33Models(): Rp33 {
  const s = parseSnapshot(rp33Sql());
  const get = <T>(t: string) => (s.get(t) ?? []) as unknown as T[];
  const rows: ModelRows = {
    tables: get<TableRow>('prj_table').sort((a, b) => (a.table_nm < b.table_nm ? -1 : 1)),
    bizAreas: get('prj_biz_area'),
    columns: get('prj_column'),
    domains: get('std_domain'),
    codeClasses: get('std_code_cls'),
    codes: get('std_code'),
  };
  const p = get<{ project_key: string; project_nm: string; default_dialect: string }>(
    'tf_project',
  )[0]!;
  return {
    models: assembleModels(rows),
    suffixes: new Set(get<{ suffix: string }>('std_domain_cls').map((d) => d.suffix)),
    project: {
      projectKey: p.project_key,
      projectNm: p.project_nm,
      defaultDialect: p.default_dialect,
    },
  };
}

/** 골든 파일 헤더 고정 메타(생성 시각·생성자 고정 → 파일이 입력에만 의존). */
export const GOLDEN_META: DdlMeta = {
  projectKey: 'RMS',
  projectNm: '연구관리시스템(이관)',
  generatedAt: '2026-09-28 14:00',
  generatedBy: 'golden',
};
