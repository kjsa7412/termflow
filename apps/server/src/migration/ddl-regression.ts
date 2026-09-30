import type pg from 'pg';
import { ddlOptionsSchema, type DdlOptions, type StdType } from '@termflow/shared';
import { classifyDefault } from '../ddl/defaults.js';
import { columnCommentText, constraintName, flattenText } from '../ddl/dialect.js';
import { dialectFor } from '../ddl/dialects.js';
import { generateTable } from '../ddl/generator.js';
import type { ColumnModel, DdlMeta, TableModel } from '../ddl/model.js';
import { validateTable } from '../ddl/validator.js';

/**
 * DDL 실행 회귀(설계서 §6.12 "실행(PostgreSQL)", §11.1 step 12, G3). 생성한 DDL을 **실제 PostgreSQL에서 실행**하고
 * `information_schema.columns`·카탈로그로 타입·NULL·기본값·코멘트·PK·CHECK를 다시 읽어 모델과 대조한다.
 *
 * 실행 격리: 대상 DB에 임시 스키마를 만들고 `search_path`를 그 스키마로 바꾼 **한 트랜잭션** 안에서 테이블마다 SAVEPOINT로
 * 실행·대조한 뒤 전부 ROLLBACK한다 — 운영 DB에서 러너가 돌아도 아무것도 남지 않고(중단돼도 트랜잭션 폐기),
 * CREATE DATABASE 권한이 필요 없다(CR-06 C6). 테스트(`test:db -- ddl-regression`)는 별도 빈 DB에서도 같은 함수를 쓴다.
 * 비인용 식별자는 소문자로 접히므로(§6.4) 카탈로그 비교는 소문자로 한다.
 */
export interface RegressionCase {
  model: TableModel;
  /** 옵션 이름(리포트용): default / drop-check / quoted / synthetic… */
  set: string;
  options: DdlOptions;
}

export interface RegressionResult {
  tableNm: string;
  set: string;
  ok: boolean;
  /** 실행 오류(있으면 대조 생략). */
  error: string | null;
  mismatches: string[];
  columns: number;
}

export const REGRESSION_OPTION_SETS: Record<string, Partial<DdlOptions>> = {
  default: {},
  'drop-check': { dropIfExists: true, codeColumnStyle: 'CHECK' },
};

const PG_TYPES: Record<StdType, string> = {
  VARCHAR: 'character varying',
  CHAR: 'character',
  TEXT: 'text',
  SMALLINT: 'smallint',
  INT: 'integer',
  BIGINT: 'bigint',
  NUMERIC: 'numeric',
  DATE: 'date',
  TIMESTAMP: 'timestamp without time zone',
  BOOLEAN: 'boolean',
  JSONB: 'jsonb',
  BYTEA: 'bytea',
};

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

/**
 * 카탈로그 기본값 표현 → 비교용 값: `'N'::character varying` → N, `(0)::numeric` → 0, `CURRENT_TIMESTAMP` 그대로.
 * 캐스트·괄호를 벗기고 따옴표 리터럴은 푼다.
 */
export function normalizeCatalogDefault(v: string | null): string | null {
  if (v === null) return null;
  let s = v.trim();
  for (;;) {
    const next = s.replace(/::[a-z ]+(\(\d+(,\d+)?\))?(\[\])?$/i, '').trim();
    const unwrapped = /^\((.*)\)$/.test(next) ? next.slice(1, -1).trim() : next;
    if (unwrapped === s) break;
    s = unwrapped;
  }
  if (/^'.*'$/s.test(s)) return s.slice(1, -1).replaceAll("''", "'");
  return s;
}

/** 모델 기본값(§6.6 판정) → 카탈로그에서 기대하는 값. 없으면 null. */
export function expectedDefault(c: ColumnModel): { value: string; exact: boolean } | null {
  const d = classifyDefault(c.defaultVal);
  switch (d.kind) {
    case 'NONE':
      return null;
    case 'NULL':
      return { value: 'NULL', exact: false };
    case 'NUMBER':
      return { value: d.value, exact: true };
    case 'FUNCTION':
      return { value: d.fn, exact: false };
    case 'BOOLEAN':
      return { value: d.value, exact: false };
    case 'STRING':
      return { value: flattenText(d.value), exact: true };
  }
}

function compareColumn(c: ColumnModel, a: InfoCol | undefined, opts: DdlOptions): string[] {
  const name = c.physicalNm;
  if (!a) return [`${name}: 컬럼 없음`];
  const out: string[] = [];
  const expect = (field: string, want: unknown, got: unknown) => {
    if (want !== got) out.push(`${name}.${field}: 기대 ${String(want)} / 실제 ${String(got)}`);
  };
  const t = c.dataType!;
  expect('data_type', PG_TYPES[t], a.data_type);
  if (t === 'VARCHAR' || t === 'CHAR') expect('length', c.dataLength, a.character_maximum_length);
  if (t === 'NUMERIC') {
    expect('precision', c.dataLength, a.numeric_precision);
    expect('scale', c.dataScale ?? 0, a.numeric_scale);
  }
  if (t === 'TIMESTAMP') expect('datetime_precision', c.dataLength ?? 6, a.datetime_precision);
  expect('is_nullable', c.isNullable && !c.isPk ? 'YES' : 'NO', a.is_nullable);
  const want = expectedDefault(c);
  const got = normalizeCatalogDefault(a.column_default);
  if (want === null) {
    if (got !== null) out.push(`${name}.default: 기대 없음 / 실제 ${got}`);
  } else if (
    got === null ||
    (want.exact ? got !== want.value : got.toUpperCase() !== want.value.toUpperCase())
  ) {
    out.push(`${name}.default: 기대 ${want.value} / 실제 ${String(got)}`);
  }
  if (opts.includeComments) {
    expect('comment', flattenText(columnCommentText(c, opts.codeColumnStyle)), a.col_comment);
  }
  return out;
}

/** 대상 스키마에서 테이블 1개 대조(실행 후). */
async function compareTable(
  client: pg.ClientBase,
  schema: string,
  t: TableModel,
  opts: DdlOptions,
): Promise<string[]> {
  const fold = (s: string) => (opts.quoteIdentifiers ? s : s.toLowerCase());
  const cased = (s: string) => (opts.identifierCase === 'LOWER' ? s.toLowerCase() : s);
  const rel = fold(cased(t.tableNm));
  const { rows: found } = await client.query<{ r: string | null }>(
    "select to_regclass(format('%I.%I', $1::text, $2::text))::text r",
    [schema, rel],
  );
  if (!found[0]?.r) return [`테이블 없음: ${rel}`];
  const { rows } = await client.query<InfoCol>(
    `select c.column_name, c.data_type, c.character_maximum_length, c.numeric_precision, c.numeric_scale,
            c.datetime_precision, c.is_nullable, c.column_default,
            col_description(format('%I.%I', c.table_schema, c.table_name)::regclass, c.ordinal_position) as col_comment
       from information_schema.columns c
      where c.table_schema = $1 and c.table_name = $2
      order by c.ordinal_position`,
    [schema, rel],
  );
  const out: string[] = [];
  if (rows.length !== t.columns.length) out.push(`컬럼 수: 기대 ${t.columns.length} / 실제 ${rows.length}`);
  const byName = new Map(rows.map((r) => [r.column_name, r]));
  t.columns.forEach((c, i) => {
    const a = byName.get(fold(cased(c.physicalNm)));
    if (a && rows[i]?.column_name !== a.column_name) out.push(`${c.physicalNm}: 순서 다름(${i + 1}번째)`);
    out.push(...compareColumn(c, a, opts));
  });
  if (opts.includeComments) {
    const { rows: tc } = await client.query<{ c: string | null }>(
      "select obj_description(format('%I.%I', $1::text, $2::text)::regclass, 'pg_class') c",
      [schema, rel],
    );
    if (tc[0]?.c !== flattenText(t.logicalNm)) {
      out.push(`테이블 코멘트: 기대 ${t.logicalNm} / 실제 ${String(tc[0]?.c)}`);
    }
  }
  const { rows: cons } = await client.query<{ conname: string; contype: string; cols: string[] }>(
    `select conname, contype,
            array(select a.attname::text from unnest(conkey) with ordinality k(n, o)
                    join pg_attribute a on a.attrelid = conrelid and a.attnum = k.n order by k.o) cols
       from pg_constraint where conrelid = format('%I.%I', $1::text, $2::text)::regclass`,
    [schema, rel],
  );
  const pk = t.columns.filter((c) => c.isPk).map((c) => fold(cased(c.physicalNm)));
  const pkRow = cons.find((c) => c.contype === 'p');
  if (pk.length > 0) {
    const name = fold(cased(constraintName('PK', t.tableNm, 63).name));
    if (!pkRow) out.push('PK 없음');
    else {
      if (pkRow.conname !== name) out.push(`PK 이름: 기대 ${name} / 실제 ${pkRow.conname}`);
      if (JSON.stringify(pkRow.cols) !== JSON.stringify(pk))
        out.push(`PK 컬럼: 기대 ${pk.join(',')} / 실제 ${pkRow.cols.join(',')}`);
    }
  } else if (pkRow) out.push('PK가 없어야 합니다');
  if (opts.codeColumnStyle === 'CHECK') {
    for (const c of t.columns) {
      if (!c.codeClsRef || c.codeClsRef.codes.length === 0) continue;
      const name = fold(cased(constraintName('CK', `${t.tableNm}_${c.physicalNm}`, 63).name));
      if (!cons.some((k) => k.contype === 'c' && k.conname === name)) out.push(`CHECK 없음: ${name}`);
    }
  }
  return out;
}

const META: DdlMeta = {
  projectKey: 'REGRESSION',
  projectNm: 'DDL 회귀',
  generatedAt: '2026-01-01 00:00',
  generatedBy: 'DDL_REGRESSION',
};

/**
 * 케이스 목록을 한 트랜잭션·임시 스키마에서 실행·대조하고 ROLLBACK한다. 검증 E가 있는 케이스는 실행하지 않고 실패로 기록.
 * 케이스마다 SAVEPOINT로 되돌리므로 같은 테이블을 옵션 세트별로 다시 만들 수 있고, 한 건 실패가 나머지를 막지 않는다.
 */
export async function runDdlRegression(
  client: pg.ClientBase,
  cases: readonly RegressionCase[],
  opts: { schema?: string } = {},
): Promise<RegressionResult[]> {
  const schema = opts.schema ?? `tf_ddl_regress_${process.pid}_${Date.now()}`;
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error(`잘못된 스키마 이름: ${schema}`);
  const pgDialect = dialectFor('POSTGRESQL');
  const results: RegressionResult[] = [];
  await client.query('BEGIN');
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}`);
    for (const [i, c] of cases.entries()) {
      const v = validateTable(c.model, { dialect: 'POSTGRESQL', quoteIdentifiers: c.options.quoteIdentifiers });
      const base = { tableNm: c.model.tableNm, set: c.set, columns: c.model.columns.length };
      if (v.errors.length > 0) {
        results.push({ ...base, ok: false, error: `검증 오류: ${v.errors.map((e) => e.code).join(', ')}`, mismatches: [] });
        continue;
      }
      const ddl = generateTable(pgDialect, { model: c.model, warnings: v.warnings }, c.options, META).sql;
      const sp = `sp_${i}`;
      await client.query(`SAVEPOINT ${sp}`);
      try {
        await client.query(ddl); // 여러 문장 → 단순 질의 프로토콜
        const mismatches = await compareTable(client, schema, c.model, c.options);
        results.push({ ...base, ok: mismatches.length === 0, error: null, mismatches });
      } catch (e) {
        results.push({ ...base, ok: false, error: e instanceof Error ? e.message : String(e), mismatches: [] });
      }
      // 옵션 세트마다 같은 테이블명을 다시 만들 수 있게 되돌린다(대조는 끝났다)
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    }
    await client.query('ROLLBACK');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
  return results;
}

/**
 * 전환 스크립트 회귀(CR-09): 옵션 세트마다 한 SAVEPOINT 안에서 **이전 이름 DDL 전부 실행 → 스크립트 본문 실행 → 새 모델과 카탈로그 대조**.
 * 전부 ROLLBACK(아무것도 남지 않음). 결과는 세트 × 새 모델마다 1행(스크립트 오류면 그 세트의 모든 행이 실패).
 */
export async function runRenameRegression(
  client: pg.ClientBase,
  pairs: readonly { oldModel: TableModel; newModel: TableModel }[],
  scriptBody: string,
  opts: { schema?: string; sets?: Record<string, Partial<DdlOptions>> } = {},
): Promise<RegressionResult[]> {
  const schema = opts.schema ?? `tf_rename_regress_${process.pid}_${Date.now()}`;
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error(`잘못된 스키마 이름: ${schema}`);
  const pgDialect = dialectFor('POSTGRESQL');
  const results: RegressionResult[] = [];
  await client.query('BEGIN');
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}`);
    for (const [set, partial] of Object.entries(opts.sets ?? REGRESSION_OPTION_SETS)) {
      const options = ddlOptionsSchema.parse(partial);
      const sp = `sp_rename_${set.replace(/[^a-z0-9]/g, '_')}`;
      await client.query(`SAVEPOINT ${sp}`);
      let error: string | null = null;
      try {
        for (const p of pairs) {
          const v = validateTable(p.oldModel, { dialect: 'POSTGRESQL' });
          await client.query(generateTable(pgDialect, { model: p.oldModel, warnings: v.warnings }, options, META).sql);
        }
        await client.query(scriptBody);
        // 이전 이름 테이블이 남지 않았는지(새 이름 = 테이블 수)
        const { rows } = await client.query<{ n: number }>(
          'select count(*)::int n from information_schema.tables where table_schema = $1',
          [schema],
        );
        if (rows[0]!.n !== pairs.length) error = `스키마 테이블 수 ${rows[0]!.n} ≠ ${pairs.length}`;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      for (const p of pairs) {
        const base = { tableNm: p.newModel.tableNm, set, columns: p.newModel.columns.length };
        if (error) {
          results.push({ ...base, ok: false, error, mismatches: [] });
          continue;
        }
        const mismatches = await compareTable(client, schema, p.newModel, options);
        results.push({ ...base, ok: mismatches.length === 0, error: null, mismatches });
      }
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    }
    await client.query('ROLLBACK');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
  return results;
}

/** RMS 모델 × 옵션 세트(default, drop-check) 케이스. */
export function regressionCases(models: readonly TableModel[]): RegressionCase[] {
  return Object.entries(REGRESSION_OPTION_SETS).flatMap(([set, partial]) => {
    const options = ddlOptionsSchema.parse(partial);
    return models.map((model) => ({ model, set, options }));
  });
}

/**
 * 합성 테이블(§6.12 이스케이프·예약어): 코멘트에 `'`·`\`·개행·탭, 문자열 기본값 `'`, 예약어 컬럼(인용 옵션으로 실행).
 */
export function syntheticCases(): RegressionCase[] {
  const col = (o: Partial<ColumnModel> & Pick<ColumnModel, 'physicalNm'>): ColumnModel => ({
    columnId: null,
    colSeq: 1,
    logicalNm: o.physicalNm,
    isPk: false,
    dataType: 'VARCHAR',
    dataLength: 20,
    dataScale: null,
    isNullable: true,
    defaultVal: null,
    colComment: null,
    domainId: null,
    codeClsId: null,
    defaultColId: null,
    matchType: 'MANUAL',
    domain: null,
    codeClsRef: null,
    ...o,
  });
  const table = (tableNm: string, logicalNm: string, columns: ColumnModel[]): TableModel => ({
    tableId: null,
    tableNm,
    logicalNm,
    description: null,
    bizAreaId: 0,
    bizCd: 'ZZ',
    bizNm: '합성',
    tablePrefix: null,
    status: null,
    version: null,
    columns: columns.map((c, i) => ({ ...c, colSeq: i + 1 })),
  });
  const escape = table('ZZ_ESCAPE', "고객's 테이블\n(합성)", [
    col({ physicalNm: 'ID', logicalNm: '아이디', isPk: true, isNullable: false, colComment: '아이디' }),
    col({ physicalNm: 'MEMO', logicalNm: '메모', colComment: "고객's\n메모 \\ 끝\t탭" }),
    col({ physicalNm: 'QUOTE_VAL', logicalNm: '인용값', dataLength: 10, defaultVal: "a'b", colComment: '인용값' }),
    col({ physicalNm: 'BACKSLASH_VAL', logicalNm: '역슬래시', dataLength: 10, defaultVal: 'C:\\x', colComment: '역슬래시' }),
    col({ physicalNm: 'NOW_TXT', logicalNm: '함수문자열', dataLength: 10, defaultVal: 'now()', colComment: '함수처럼 보이는 문자열' }),
    col({ physicalNm: 'AMT', logicalNm: '금액', dataType: 'NUMERIC', dataLength: 12, dataScale: 2, defaultVal: '0', colComment: '금액' }),
    col({ physicalNm: 'USE_YN', logicalNm: '사용여부', dataType: 'BOOLEAN', dataLength: null, defaultVal: 'TRUE', colComment: '사용여부' }),
    col({ physicalNm: 'REG_DT', logicalNm: '등록일', dataType: 'DATE', dataLength: null, defaultVal: 'SYSDATE', colComment: '등록일' }),
    col({ physicalNm: 'NULL_VAL', logicalNm: '널', dataLength: 5, defaultVal: 'null', colComment: '널' }),
    col({ physicalNm: 'BIN', logicalNm: '이진', dataType: 'BYTEA', dataLength: null, colComment: '이진' }),
    col({ physicalNm: 'DOC', logicalNm: '문서', dataType: 'JSONB', dataLength: null, colComment: '문서' }),
    col({ physicalNm: 'CNT', logicalNm: '건수', dataType: 'BIGINT', dataLength: null, colComment: '건수' }),
    col({ physicalNm: 'SEQ', logicalNm: '순번', dataType: 'SMALLINT', dataLength: null, colComment: '순번' }),
    col({ physicalNm: 'NO', logicalNm: '번호', dataType: 'INT', dataLength: null, colComment: '번호' }),
    col({ physicalNm: 'GB', logicalNm: '구분', dataType: 'CHAR', dataLength: 1, defaultVal: 'Y', colComment: '구분' }),
    col({ physicalNm: 'BODY', logicalNm: '본문', dataType: 'TEXT', dataLength: null, colComment: '본문' }),
    col({ physicalNm: 'TS6', logicalNm: '시각', dataType: 'TIMESTAMP', dataLength: null, defaultVal: 'NOW()', colComment: '시각' }),
  ]);
  const reserved = table('ORDER', '예약어 테이블', [
    col({ physicalNm: 'USER', logicalNm: '사용자', isPk: true, isNullable: false, colComment: '사용자' }),
    col({ physicalNm: 'ORDER', logicalNm: '순서', dataType: 'INT', dataLength: null, colComment: '순서' }),
    col({ physicalNm: 'DESC', logicalNm: '설명', dataLength: 100, colComment: '설명' }),
  ]);
  const o = (p: Partial<DdlOptions>) => ddlOptionsSchema.parse(p);
  return [
    { model: escape, set: 'synthetic-escape', options: o({}) },
    { model: escape, set: 'synthetic-escape-lower', options: o({ identifierCase: 'LOWER', dropIfExists: true }) },
    { model: reserved, set: 'synthetic-reserved-quoted', options: o({ quoteIdentifiers: true }) },
  ];
}
