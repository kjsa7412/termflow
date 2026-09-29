/**
 * `test/seed/rp33.sql` 생성(T7.10, 설계서 §13.3 "승계 완료 상태 스냅샷"). 승계 러너(1~11)가 끝난 DB의 RMS에서
 * DDL·검증에 필요한 행만 뽑아 **빈 DB에 그대로 적재 가능한 SQL**로 쓴다(ID 유지).
 *
 *   pnpm --filter @termflow/server ddl:rp33 [-- --project=RMS --out=test/seed/rp33.sql]
 *
 * 포함: 프로젝트 1 · 업무구분 전부 · 도메인분류 전부(접미어 판정) · 컬럼이 참조하는 도메인·코드구분(+ 코드) ·
 *       기본 기본컬럼 세트(+ 구성) · 테이블 33 · 컬럼 649. 표준 원본(STDV1) 참조(origin·copied_from)는 NULL.
 * 형식: 표마다 `INSERT … OVERRIDING SYSTEM VALUE SELECT * FROM json_populate_recordset(NULL::표, $json$[행…]$json$)`
 *       — DB 테스트는 그대로 실행하고, 골든 파일 단위 테스트(`pnpm test`)는 같은 JSON을 읽어 TableModel을 조립한다(단일 원천).
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { loadEnvOrExit } from '../src/config/load-env.js';
import { createPool } from '../src/db/client.js';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

/** (표, 조회 SQL, IDENTITY 컬럼). 조회 결과의 컬럼 순서 = 표 컬럼 순서(row_to_json). */
function queries(pid: number): [string, string, string | null][] {
  const nullOrigin =
    "jsonb_set(jsonb_set(to_jsonb(x), '{origin_project_id}', 'null'), '{origin_id}', 'null')";
  return [
    [
      'tf_project',
      `select jsonb_set(jsonb_set(to_jsonb(x), '{copied_from_project_id}', 'null'), '{default_col_set_id}', 'null') j
         from tf_project x where project_id = ${pid}`,
      'project_id',
    ],
    [
      'prj_biz_area',
      `select ${nullOrigin} j from prj_biz_area x where project_id = ${pid} order by biz_area_id`,
      'biz_area_id',
    ],
    [
      'std_domain_cls',
      `select ${nullOrigin} j from std_domain_cls x where project_id = ${pid} order by domain_cls_id`,
      'domain_cls_id',
    ],
    [
      'std_domain',
      `select ${nullOrigin} j from std_domain x where project_id = ${pid}
          and domain_id in (select domain_id from prj_column where project_id = ${pid}) order by domain_id`,
      'domain_id',
    ],
    [
      'std_code_cls',
      `select ${nullOrigin} j from std_code_cls x where project_id = ${pid}
          and code_cls_id in (select code_cls_id from prj_column where project_id = ${pid}) order by code_cls_id`,
      'code_cls_id',
    ],
    [
      'std_code',
      `select ${nullOrigin} j from std_code x where project_id = ${pid}
          and code_cls_id in (select code_cls_id from prj_column where project_id = ${pid}) order by code_id`,
      'code_id',
    ],
    [
      'std_default_col_set',
      `select ${nullOrigin} j from std_default_col_set x where project_id = ${pid} and is_default order by set_id`,
      'set_id',
    ],
    [
      'std_default_col',
      `select ${nullOrigin} j from std_default_col x where project_id = ${pid}
          and set_id in (select set_id from std_default_col_set where project_id = ${pid} and is_default) order by default_col_id`,
      'default_col_id',
    ],
    [
      'prj_table',
      `select to_jsonb(x) j from prj_table x where project_id = ${pid} order by table_id`,
      'table_id',
    ],
    [
      'prj_column',
      `select to_jsonb(x) j from prj_column x where project_id = ${pid} order by column_id`,
      'column_id',
    ],
  ];
}

async function main(): Promise<void> {
  const env = loadEnvOrExit();
  const key = arg('project', 'RMS');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const out = path.resolve(here, '..', arg('out', 'test/seed/rp33.sql'));
  const pool: pg.Pool = createPool({ ...env, DB_POOL_MAX: 1 });
  try {
    const { rows: p } = await pool.query<{ project_id: number; default_col_set_id: number | null }>(
      'select project_id, default_col_set_id from tf_project where project_key = $1',
      [key],
    );
    if (!p[0])
      throw new Error(
        `프로젝트 ${key}가 없습니다 — 승계 러너 2차(COPY_TO_RMS..RECONCILE)를 먼저 실행하십시오`,
      );
    const pid = p[0].project_id;
    const parts: string[] = [
      '-- =====================================================================',
      `-- test/seed/rp33.sql — 승계 완료 스냅샷(프로젝트 ${key}, 설계서 §13.3, TODO T7.10)`,
      '-- 생성: pnpm --filter @termflow/server ddl:rp33 (승계 러너 1~11 결과 DB에서). 직접 수정 금지 — 러너 결과가 바뀌면 다시 생성',
      '-- 용도: DDL 골든 파일(pnpm test -- ddl-golden: JSON을 읽어 TableModel 조립) · DB 테스트(빈 DB에 그대로 실행)',
      '-- 실행 전제: 0001_baseline 적용 직후의 빈 DB. ID는 원본 그대로, IDENTITY는 적재 후 최댓값으로 맞춘다',
      '-- =====================================================================',
      '',
    ];
    const counts: string[] = [];
    for (const [table, sqlText, identity] of queries(pid)) {
      const { rows } = await pool.query<{ j: unknown }>(sqlText);
      counts.push(`${table} ${rows.length}`);
      const json = rows.map((r) => JSON.stringify(r.j)).join(',\n');
      if (json.includes('$json$')) throw new Error(`${table} 행에 구분자 $json$이 있습니다`);
      parts.push(
        `-- ${table}: ${rows.length}행`,
        `INSERT INTO ${table} OVERRIDING SYSTEM VALUE`,
        `SELECT * FROM json_populate_recordset(NULL::${table}, $json$[`,
        json,
        ']$json$);',
      );
      if (identity) {
        parts.push(
          `SELECT setval(pg_get_serial_sequence('${table}', '${identity}'), (SELECT coalesce(max(${identity}), 1) FROM ${table}));`,
        );
      }
      parts.push('');
    }
    if (p[0].default_col_set_id !== null) {
      parts.push(
        `UPDATE tf_project SET default_col_set_id = ${p[0].default_col_set_id} WHERE project_id = ${pid};`,
        '',
      );
    }
    writeFileSync(out, parts.join('\n'), 'utf8');
    console.log(`[ddl:rp33] ${key} → ${out} (${counts.join(' · ')})`);
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(`[ddl:rp33] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
