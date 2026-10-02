import { fillJosa, type Dialect, type StdType } from '@termflow/shared';
import type { DefaultSpec } from './defaults.js';
import { classifyDefault } from './defaults.js';
import {
  columnCommentText,
  constraintName,
  flattenText,
  renderIdentifier,
  type ColumnWidths,
  type DdlDialect,
  type GenIssue,
  type IdentifierOpts,
  type Rendered,
  type RenderOpts,
} from './dialect.js';
import type { CodeSummary, ColumnModel, TableModel } from './model.js';
import { reservedWords } from './reserved-words.js';
import { mapStdType, typeMapping, type MappedType, type TypeMapping } from './type-mapping.js';

const INDENT = '    ';
/** 열 정렬 최소 폭(§6.8 예시: 물리명 20, 타입 14). 더 긴 이름이 있으면 가장 긴 값 + 1. */
export const MIN_NAME_WIDTH = 20;
export const MIN_TYPE_WIDTH = 14;

/**
 * PostgreSQL 17 방언(설계서 §6.2~§6.8, D2 MVP 방언). 출력 형식은 §6.8 예시와 문자 단위로 같다(T7.7 DoD).
 *  - 비인용 식별자는 카탈로그에서 소문자로 접힌다(DDL은 대문자 출력, §6.4) → 회귀 대조는 소문자 비교(PoC T1.7)
 *  - `COMMENT ON` 문으로 코멘트, 인라인 코멘트 없음
 */
export class PostgresDialect implements DdlDialect {
  private readonly mapping: TypeMapping = typeMapping('POSTGRESQL');

  id(): Dialect {
    return 'POSTGRESQL';
  }

  identifierMaxLength(): number {
    return this.mapping.identifierMaxLength;
  }

  identifier(name: string, opts: IdentifierOpts): string {
    return renderIdentifier(name, opts, this.mapping.quote);
  }

  qualifiedName(name: string, opts: RenderOpts): string {
    const id = this.identifier(name, opts);
    return opts.schemaName ? `${this.identifier(opts.schemaName, opts)}.${id}` : id;
  }

  mapType(type: StdType, length: number | null, scale: number | null): MappedType {
    return mapStdType(this.mapping, type, length, scale);
  }

  literal(text: string): string {
    return `'${flattenText(text).replaceAll("'", "''")}'`;
  }

  renderDefault(spec: DefaultSpec, _colType: StdType | null): string | undefined {
    switch (spec.kind) {
      case 'NONE':
        return undefined;
      case 'NULL':
        return 'NULL';
      case 'NUMBER':
        return spec.value;
      case 'FUNCTION':
        return this.mapping.defaults[spec.fn];
      case 'BOOLEAN':
        return this.mapping.defaults[spec.value];
      case 'STRING':
        return this.literal(spec.value);
    }
  }

  private columnType(col: ColumnModel): MappedType {
    if (col.dataType === null)
      throw new Error(`타입 없는 컬럼은 생성할 수 없습니다: ${col.physicalNm}`);
    return this.mapType(col.dataType, col.dataLength, col.dataScale);
  }

  columnDefinition(col: ColumnModel, opts: RenderOpts, widths: ColumnWidths): string {
    const name = this.identifier(col.physicalNm, opts);
    const type = this.columnType(col).sql;
    const attrs: string[] = [];
    for (const a of this.mapping.columnAttributeOrder) {
      if (a === 'NULLABILITY' && (!col.isNullable || col.isPk)) attrs.push('NOT NULL');
      if (a === 'DEFAULT') {
        const d = this.renderDefault(classifyDefault(col.defaultVal), col.dataType);
        if (d !== undefined) attrs.push(`DEFAULT ${d}`);
      }
    }
    const body = attrs.length > 0 ? `${type.padEnd(widths.type)} ${attrs.join(' ')}` : type;
    return `${INDENT}${name.padEnd(widths.name)} ${body}`;
  }

  /** 열 정렬 폭: 최소(20/14) 또는 가장 긴 값 + 1. */
  widths(table: TableModel, opts: RenderOpts): ColumnWidths {
    let name = 0;
    let type = 0;
    for (const c of table.columns) {
      name = Math.max(name, this.identifier(c.physicalNm, opts).length);
      type = Math.max(type, this.columnType(c).sql.length);
    }
    return { name: Math.max(MIN_NAME_WIDTH, name + 1), type: Math.max(MIN_TYPE_WIDTH, type + 1) };
  }

  createTable(table: TableModel, opts: RenderOpts): Rendered {
    const warnings: GenIssue[] = [];
    const widths = this.widths(table, opts);
    const lines = table.columns.map((c) => {
      for (const w of this.columnType(c).warnings) warnings.push({ ...w, columnNm: c.physicalNm });
      return this.columnDefinition(c, opts, widths);
    });
    const pk = table.columns.filter((c) => c.isPk);
    if (pk.length > 0) {
      const cn = constraintName('PK', table.tableNm, this.identifierMaxLength());
      if (cn.shortened) {
        warnings.push({
          code: 'W_CONSTRAINT_NM_SHORTENED',
          message: fillJosa(`PK 제약명을 ${cn.name}(으)로 축약했습니다`),
        });
      }
      const cols = pk.map((c) => this.identifier(c.physicalNm, opts)).join(', ');
      lines.push(`${INDENT}CONSTRAINT ${this.identifier(cn.name, opts)} PRIMARY KEY (${cols})`);
    }
    if (opts.codeColumnStyle === 'CHECK') {
      for (const c of table.columns) {
        if (!c.codeClsRef) continue;
        const ck = this.checkConstraint(table, c, c.codeClsRef, opts);
        if (!ck) continue;
        warnings.push(...ck.warnings);
        lines.push(`${INDENT}${ck.sql}`);
      }
    }
    const sql = [
      `CREATE TABLE ${this.qualifiedName(table.tableNm, opts)} (`,
      lines.join(',\n'),
      `)${this.terminator()}`,
    ].join('\n');
    return { sql, warnings };
  }

  checkConstraint(
    table: TableModel,
    col: ColumnModel,
    codes: CodeSummary,
    opts: RenderOpts,
  ): Rendered | undefined {
    if (codes.codes.length === 0) return undefined;
    const warnings: GenIssue[] = [];
    const cn = constraintName(
      'CK',
      `${table.tableNm}_${col.physicalNm}`,
      this.identifierMaxLength(),
    );
    if (cn.shortened) {
      warnings.push({
        code: 'W_CONSTRAINT_NM_SHORTENED',
        message: fillJosa(`CHECK 제약명을 ${cn.name}(으)로 축약했습니다`),
        columnNm: col.physicalNm,
      });
    }
    const values = codes.codes.map((c) => this.literal(c.code)).join(', ');
    return {
      sql: `CONSTRAINT ${this.identifier(cn.name, opts)} CHECK (${this.identifier(col.physicalNm, opts)} IN (${values}))`,
      warnings,
    };
  }

  comments(table: TableModel, opts: RenderOpts): string[] {
    const t = this.qualifiedName(table.tableNm, opts);
    const out = [`COMMENT ON TABLE  ${t} IS ${this.literal(table.logicalNm)}${this.terminator()}`];
    for (const c of table.columns) {
      const text = columnCommentText(c, opts.codeColumnStyle);
      out.push(
        `COMMENT ON COLUMN ${t}.${this.identifier(c.physicalNm, opts)} IS ${this.literal(text)}${this.terminator()}`,
      );
    }
    return out;
  }

  inlineComment(_text: string): string | undefined {
    return undefined;
  }

  dropTable(name: string, ifExists: boolean, opts: RenderOpts): string {
    return `DROP TABLE ${ifExists ? 'IF EXISTS ' : ''}${this.qualifiedName(name, opts)}${this.terminator()}`;
  }

  reservedWords(): ReadonlySet<string> {
    return reservedWords('POSTGRESQL');
  }

  terminator(): string {
    return ';';
  }

  blockTerminator(): string {
    return ';';
  }
}
