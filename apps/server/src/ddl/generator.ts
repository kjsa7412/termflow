import type { DdlOptions, ValidationIssue } from '@termflow/shared';
import type { DdlDialect, GenIssue } from './dialect.js';
import type { DdlMeta, TableModel } from './model.js';

/**
 * DDL 생성기(설계서 §6.1·§6.8·§6.10). 순수 함수: (모델 + 옵션 + 메타) → 문자열. 생성 단위는 테이블 1개,
 * 다중 테이블은 SINGLE(헤더 1개 + 블록을 빈 줄 2개로 구분, DROP은 역순으로 앞에) 또는 PER_TABLE(테이블별 파일)로 묶는다.
 * 검증(§5.7)은 호출자가 먼저 한다 — E가 있으면 생성하지 않는다(422). 여기서는 W만 받아 헤더 요약에 싣는다.
 */
export interface TableInput {
  model: TableModel;
  /** 검증기 경고(§5.7 W_*). */
  warnings: ValidationIssue[];
}

export interface TableOutput {
  model: TableModel;
  /** 테이블 1개 파일(헤더 포함) — GET P/tables/{id}/ddl·PER_TABLE 파일·골든 파일과 같다. */
  sql: string;
  /** 검증 경고 + 생성 경고. */
  warnings: ValidationIssue[];
}

export interface BundleFile {
  name: string;
  content: string;
}

export interface Bundle {
  tables: TableOutput[];
  /** SINGLE 파일 본문. */
  sql: string;
  warnings: ValidationIssue[];
  /** 다운로드 파일 이름(SINGLE: .sql, PER_TABLE: .zip 안 경로 + `_warnings.txt`). */
  singleFileName: string;
  zipFileName: string;
  perTableFiles: BundleFile[];
}

const DIALECT_LABEL = { POSTGRESQL: 'POSTGRESQL', ORACLE: 'ORACLE', MYSQL: 'MYSQL' } as const;

function genToIssue(t: TableModel, g: GenIssue): ValidationIssue {
  return {
    code: g.code,
    target: g.columnNm ? 'column' : 'table',
    message: g.message,
    ...(t.tableId !== null ? { tableId: t.tableId } : {}),
    tableNm: t.tableNm,
    ...(g.columnNm ? { columnNm: g.columnNm } : {}),
  };
}

/** 경고 요약 `경고 3건: W_COMMENT_EMPTY 2, W_PK_NONE 1`(건수 내림차순 → 코드). */
export function warningSummary(warnings: readonly ValidationIssue[]): string | null {
  if (warnings.length === 0) return null;
  const byCode = new Map<string, number>();
  for (const w of warnings) byCode.set(w.code, (byCode.get(w.code) ?? 0) + 1);
  const parts = [...byCode]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([c, n]) => `${c} ${n}`);
  return `경고 ${warnings.length}건: ${parts.join(', ')}`;
}

/** 헤더 주석(§6.8 첫 줄) + 인용 주의(§6.4) + 경고 요약(§6.10). includeHeader=false면 없음. */
export function headerLines(
  d: DdlDialect,
  meta: DdlMeta,
  tables: readonly TableModel[],
  warnings: readonly ValidationIssue[],
  opts: DdlOptions,
): string[] {
  if (!opts.includeHeader) return [];
  const biz = [...new Set(tables.map((t) => t.bizCd ?? '-'))].join(', ');
  const lines = [
    `-- TermFlow DDL | 프로젝트 ${meta.projectKey} ${meta.projectNm} · 업무구분 ${biz} | 방언 ${DIALECT_LABEL[d.id()]} | ${meta.generatedAt} | ${meta.generatedBy}`,
  ];
  if (opts.quoteIdentifiers) {
    lines.push(
      '-- 주의: 인용 식별자는 대소문자를 보존합니다 — 이후 모든 질의에서 같은 인용("…")이 필요합니다',
    );
  }
  const summary = warningSummary(warnings);
  if (summary) lines.push(`-- ${summary}`);
  return lines;
}

/** 테이블 블록: [DROP] + CREATE + [COMMENT ON …]. 끝 개행 없음. */
export function tableBlock(
  d: DdlDialect,
  t: TableModel,
  opts: DdlOptions,
  withDrop: boolean,
): { sql: string; warnings: GenIssue[] } {
  const parts: string[] = [];
  if (withDrop) parts.push(d.dropTable(t.tableNm, true, opts));
  const created = d.createTable(t, opts);
  parts.push(created.sql);
  if (opts.includeComments) parts.push(...d.comments(t, opts));
  return { sql: parts.join('\n'), warnings: created.warnings };
}

function finish(text: string, opts: DdlOptions): string {
  const lf = `${text}\n`;
  return opts.lineEnding === 'CRLF' ? lf.replaceAll('\n', '\r\n') : lf;
}

/** 테이블 1개 파일(헤더 + 블록). */
export function generateTable(
  d: DdlDialect,
  input: TableInput,
  opts: DdlOptions,
  meta: DdlMeta,
): TableOutput {
  const block = tableBlock(d, input.model, opts, opts.dropIfExists);
  const warnings = [...input.warnings, ...block.warnings.map((g) => genToIssue(input.model, g))];
  const header = headerLines(d, meta, [input.model], warnings, opts);
  return { model: input.model, sql: finish([...header, block.sql].join('\n'), opts), warnings };
}

/** `yyyy-MM-dd HH:mm` → `yyyyMMdd_HHmm`(§6.10 파일명). */
export function fileStamp(generatedAt: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(generatedAt);
  if (!m) throw new Error(`generatedAt 형식 오류: ${generatedAt}`);
  return `${m[1]}${m[2]}${m[3]}_${m[4]}${m[5]}`;
}

/** 다중 테이블(§6.10). 테이블 순서는 입력 순서(호출자가 사용자 정렬 → 업무구분 sort_no → 물리명으로 정한다). */
export function generateBundle(
  d: DdlDialect,
  inputs: readonly TableInput[],
  opts: DdlOptions,
  meta: DdlMeta,
): Bundle {
  const tables = inputs.map((i) => generateTable(d, i, opts, meta));
  const warnings = tables.flatMap((t) => t.warnings);
  const models = inputs.map((i) => i.model);
  const n = models.length;

  // SINGLE: 헤더 1개 → [DROP 역순] → 블록(`-- i/n 물리명 논리명 (vN, 상태)`)을 빈 줄 2개로 구분
  let single: string;
  if (n === 1) {
    single = tables[0]!.sql;
  } else {
    const header = headerLines(d, meta, models, warnings, opts);
    const segments: string[] = [];
    if (opts.dropIfExists) {
      segments.push(
        [...models]
          .reverse()
          .map((m) => d.dropTable(m.tableNm, true, opts))
          .join('\n'),
      );
    }
    models.forEach((m, i) => {
      const ver = m.version !== null ? ` (v${m.version}${m.status ? `, ${m.status}` : ''})` : '';
      const title = `-- ${i + 1}/${n} ${m.tableNm} ${m.logicalNm}${ver}`.replace(/[\r\n]+/g, ' ');
      segments.push(`${title}\n${tableBlock(d, m, opts, false).sql}`);
    });
    single = finish([...header, segments.join('\n\n\n')].join('\n'), opts);
  }

  // PER_TABLE: `{BIZ_CD}/{NN}_{TABLE}.sql`(업무구분 폴더 안 2자리 순번) + `_warnings.txt`
  const seqByBiz = new Map<string, number>();
  const perTableFiles: BundleFile[] = tables.map((t) => {
    const biz = t.model.bizCd ?? '_';
    const nn = (seqByBiz.get(biz) ?? 0) + 1;
    seqByBiz.set(biz, nn);
    return { name: `${biz}/${String(nn).padStart(2, '0')}_${t.model.tableNm}.sql`, content: t.sql };
  });
  perTableFiles.push({ name: '_warnings.txt', content: warningsText(meta, d, tables, opts) });

  const stamp = fileStamp(meta.generatedAt);
  const baseName = `${meta.projectKey}_${d.id()}_${stamp}`;
  return {
    tables,
    sql: single,
    warnings,
    singleFileName: `${baseName}.sql`,
    zipFileName: `${baseName}.zip`,
    perTableFiles,
  };
}

/** ZIP 안 `_warnings.txt`: 요약 1줄 + 경고 1건 1줄(`테이블[.컬럼] [코드] 메시지`). */
export function warningsText(
  meta: DdlMeta,
  d: DdlDialect,
  tables: readonly TableOutput[],
  opts: DdlOptions,
): string {
  const all = tables.flatMap((t) => t.warnings);
  const lines = [
    `TermFlow DDL 경고 | 프로젝트 ${meta.projectKey} | 방언 ${d.id()} | ${meta.generatedAt} | 테이블 ${tables.length}개`,
    warningSummary(all) ?? '경고 0건',
    '',
    ...all.map(
      (w) => `${w.tableNm ?? '-'}${w.columnNm ? `.${w.columnNm}` : ''}\t[${w.code}]\t${w.message}`,
    ),
  ];
  return finish(lines.join('\n'), opts);
}
