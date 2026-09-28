import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../setup/databases.js';

// T1.7 DDL 1테이블: §6.8 RP_RSCH_PRJ_MST 축약본을 최소 PostgresDialect로 생성 → 실행 → information_schema 대조(§6.12)
// PoC 전용 최소 구현. 정식 DdlDialect·매핑 YAML·검증은 단계 7(T7.x).

type StdType = 'VARCHAR' | 'CHAR' | 'NUMERIC' | 'TIMESTAMP' | 'INT';
interface Col {
  physicalNm: string;
  logicalNm: string;
  type: StdType;
  length?: number;
  scale?: number;
  nullable: boolean;
  pk?: boolean;
  defaultVal?: string;
  comment?: string;
}
interface Tbl {
  tableNm: string;
  logicalNm: string;
  columns: Col[];
}

const IDENT = /^[A-Z][A-Z0-9_]*$/;
const q = (s: string) => `'${s.replace(/'/g, "''").replace(/[\r\n\t]+/g, ' ')}'`;

function pgType(c: Col): string {
  switch (c.type) {
    case 'VARCHAR':
    case 'CHAR':
      return `${c.type}(${c.length})`;
    case 'NUMERIC':
      return c.scale != null ? `NUMERIC(${c.length},${c.scale})` : `NUMERIC(${c.length})`;
    case 'TIMESTAMP':
      return c.length != null ? `TIMESTAMP(${c.length})` : 'TIMESTAMP';
    case 'INT':
      return 'INTEGER';
  }
}

/** §6.6 DEFAULT 판정(화이트리스트 함수·숫자·불리언 외에는 문자열 리터럴). */
function pgDefault(v: string | undefined): string | undefined {
  if (v == null || v.trim() === '') return undefined;
  const t = v.trim();
  if (/^null$/i.test(t)) return 'NULL';
  if (/^-?\d+(\.\d+)?$/.test(t)) return t;
  if (/^(current_timestamp|now\(\))$/i.test(t)) return 'CURRENT_TIMESTAMP';
  if (/^(current_date|sysdate)$/i.test(t)) return 'CURRENT_DATE';
  if (/^(true|false)$/i.test(t)) return t.toUpperCase();
  return q(t);
}

function renderPostgres(t: Tbl, header: string): string {
  for (const id of [t.tableNm, ...t.columns.map((c) => c.physicalNm)]) {
    if (!IDENT.test(id)) throw new Error(`식별자 검증 실패: ${id}`); // §6.4 인젝션 방지
  }
  const lines = t.columns.map((c) => {
    const attrs: string[] = [];
    if (!c.nullable || c.pk) attrs.push('NOT NULL');
    const d = pgDefault(c.defaultVal);
    if (d) attrs.push(`DEFAULT ${d}`);
    const type = pgType(c);
    const body = attrs.length ? `${type.padEnd(14)} ${attrs.join(' ')}` : type;
    return `    ${c.physicalNm.padEnd(20)} ${body}`;
  });
  const pk = t.columns.filter((c) => c.pk).map((c) => c.physicalNm);
  if (pk.length) lines.push(`    CONSTRAINT PK_${t.tableNm} PRIMARY KEY (${pk.join(', ')})`);
  const out = [header, `CREATE TABLE ${t.tableNm} (`, lines.join(',\n'), ');'];
  out.push(`COMMENT ON TABLE  ${t.tableNm} IS ${q(t.logicalNm)};`);
  for (const c of t.columns) {
    out.push(`COMMENT ON COLUMN ${t.tableNm}.${c.physicalNm} IS ${q(c.comment || c.logicalNm)};`);
  }
  return out.join('\n') + '\n';
}

const RP_RSCH_PRJ_MST: Tbl = {
  tableNm: 'RP_RSCH_PRJ_MST',
  logicalNm: '연구과제마스터',
  columns: [
    {
      physicalNm: 'WRK_MAST_ID',
      logicalNm: '업무마스터ID',
      type: 'VARCHAR',
      length: 20,
      nullable: false,
      pk: true,
    },
    {
      physicalNm: 'RSCH_PRJ_ID',
      logicalNm: '연구과제ID',
      type: 'VARCHAR',
      length: 20,
      nullable: false,
    },
    {
      physicalNm: 'PRGRS_STAT_CD',
      logicalNm: '진행상태코드',
      type: 'VARCHAR',
      length: 10,
      nullable: true,
      comment: '진행상태코드(RP/RP040: 01 계획, 02 진행, 03 완료)',
    },
    {
      physicalNm: 'END_YN',
      logicalNm: '종료여부',
      type: 'VARCHAR',
      length: 1,
      nullable: false,
      defaultVal: 'N',
    },
    { physicalNm: 'PRJ_NM', logicalNm: '과제명', type: 'VARCHAR', length: 30, nullable: true },
    {
      physicalNm: 'EVL_CMTE_WGHTD_VAL',
      logicalNm: '평가위원회가중치',
      type: 'NUMERIC',
      length: 6,
      scale: 2,
      nullable: true,
    },
    {
      physicalNm: 'FIRS_REG_DTS',
      logicalNm: '최초등록일시',
      type: 'TIMESTAMP',
      length: 0,
      nullable: true,
      defaultVal: 'CURRENT_TIMESTAMP',
    },
    {
      physicalNm: 'FINA_REG_USER_ID',
      logicalNm: '최종등록자ID',
      type: 'VARCHAR',
      length: 20,
      nullable: true,
    },
  ],
};

/** 설계서 §6.8의 PostgreSQL 예시 블록(첫 ```sql)을 읽는다. */
function designExample(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const doc = readFileSync(path.resolve(here, '../../../../../docs/02_설계서.md'), 'utf8')
    .split('\r\n')
    .join('\n');
  const sec = doc.slice(doc.indexOf('### 6.8'));
  const start = sec.indexOf('```sql\n') + '```sql\n'.length;
  return sec.slice(start, sec.indexOf('```', start));
}

interface InfoCol {
  column_name: string;
  data_type: string;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
  datetime_precision: number | null;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
  col_comment: string | null;
}

function expectedInfo(c: Col): Omit<InfoCol, 'col_comment'> & { col_comment: string } {
  const base = {
    column_name: c.physicalNm.toLowerCase(), // 비인용 식별자는 소문자로 접힌다(§6.4)
    character_maximum_length: null as number | null,
    numeric_precision: null as number | null,
    numeric_scale: null as number | null,
    datetime_precision: null as number | null,
    is_nullable: (c.nullable && !c.pk ? 'YES' : 'NO') as 'YES' | 'NO',
    column_default: null as string | null,
    col_comment: c.comment || c.logicalNm,
  };
  let dataType = '';
  if (c.type === 'VARCHAR') {
    dataType = 'character varying';
    base.character_maximum_length = c.length!;
  } else if (c.type === 'NUMERIC') {
    dataType = 'numeric';
    base.numeric_precision = c.length!;
    base.numeric_scale = c.scale ?? 0;
  } else if (c.type === 'TIMESTAMP') {
    dataType = 'timestamp without time zone';
    base.datetime_precision = c.length ?? 6;
  }
  const d = pgDefault(c.defaultVal);
  if (d === 'CURRENT_TIMESTAMP') base.column_default = 'CURRENT_TIMESTAMP';
  else if (d?.startsWith("'")) base.column_default = `${d}::character varying`;
  else if (d) base.column_default = d;
  return { ...base, data_type: dataType };
}

describe('poc/ddl (T1.7)', () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createDatabase('poc_ddl') });
  });
  afterAll(async () => {
    await pool.end();
  });

  const header =
    '-- TermFlow DDL | 프로젝트 RMS 연구관리시스템(이관) · 업무구분 RP | 방언 POSTGRESQL | 2026-09-28 14:00 | hong';

  it('생성 DDL이 설계서 §6.8 PostgreSQL 예시와 문자 단위로 같다', () => {
    expect(renderPostgres(RP_RSCH_PRJ_MST, header)).toBe(designExample());
  });

  it('컨테이너에서 실행 성공 → information_schema.columns 대조 불일치 0', async () => {
    const ddl = renderPostgres(RP_RSCH_PRJ_MST, header);
    await pool.query(ddl); // 여러 문장 → 단순 질의 프로토콜, 암묵 트랜잭션
    const { rows } = await pool.query<InfoCol>(
      `select c.column_name, c.data_type, c.character_maximum_length, c.numeric_precision, c.numeric_scale,
              c.datetime_precision, c.is_nullable, c.column_default,
              col_description(format('%I.%I', c.table_schema, c.table_name)::regclass, c.ordinal_position) as col_comment
         from information_schema.columns c
        where c.table_schema = 'public' and c.table_name = 'rp_rsch_prj_mst'
        order by c.ordinal_position`,
    );
    const expected = RP_RSCH_PRJ_MST.columns.map(expectedInfo);
    const mismatches: string[] = [];
    expected.forEach((e, i) => {
      const a = rows[i] as unknown as Record<string, unknown> | undefined;
      for (const [k, v] of Object.entries(e)) {
        if (a?.[k] !== v)
          mismatches.push(`${e.column_name}.${k}: 기대 ${String(v)} / 실제 ${String(a?.[k])}`);
      }
    });
    console.log(`[poc/ddl] 컬럼 ${rows.length}개 대조, 불일치 ${mismatches.length}건`);
    expect(mismatches).toEqual([]);
    expect(rows).toHaveLength(8);

    const pk = await pool.query<{ conname: string; def: string }>(
      "select conname, pg_get_constraintdef(oid) def from pg_constraint where conrelid='rp_rsch_prj_mst'::regclass and contype='p'",
    );
    expect(pk.rows).toEqual([{ conname: 'pk_rp_rsch_prj_mst', def: 'PRIMARY KEY (wrk_mast_id)' }]);
    const tc = await pool.query<{ c: string }>(
      "select obj_description('rp_rsch_prj_mst'::regclass) c",
    );
    expect(tc.rows[0]?.c).toBe('연구과제마스터');
  });

  it('코멘트의 작은따옴표·개행 이스케이프가 실행된다(§6.5)', async () => {
    const t: Tbl = {
      tableNm: 'POC_ESCAPE',
      logicalNm: "고객's 테이블",
      columns: [
        {
          physicalNm: 'MEMO',
          logicalNm: '메모',
          type: 'VARCHAR',
          length: 10,
          nullable: true,
          comment: "고객's\n메모 \\ 끝",
        },
      ],
    };
    await pool.query(renderPostgres(t, '-- escape'));
    const r = await pool.query<{ c: string }>(
      "select col_description('poc_escape'::regclass, 1) c",
    );
    expect(r.rows[0]?.c).toBe("고객's 메모 \\ 끝");
    expect(() => renderPostgres({ ...t, tableNm: 'X; DROP TABLE Y' }, '')).toThrow(/식별자/);
  });
});
