import { createHash } from 'node:crypto';
import {
  DDL_CODE_SUMMARY_MAX,
  IDENTIFIER_RE,
  type DdlOptions,
  type Dialect,
  type StdType,
} from '@termflow/shared';
import type { DefaultSpec } from './defaults.js';
import type { CodeSummary, ColumnModel, TableModel } from './model.js';
import type { MappedType } from './type-mapping.js';

/**
 * DDL 방언 인터페이스(설계서 §6.2). 메서드 이름·역할은 표와 같다(반환 타입은 TS 표기: `string[]`, `string | undefined`,
 * `ReadonlySet<string>`). MVP 구현은 PostgreSQL 1종(D2) — Oracle·MySQL은 매핑 YAML·예약어 파일(데이터)만 두고
 * 구현 클래스는 2차(`dialects.ts` 레지스트리가 422 `E_DIALECT_UNSUPPORTED`로 막는다).
 */
export type IdentifierOpts = Pick<DdlOptions, 'identifierCase' | 'quoteIdentifiers'>;
export type RenderOpts = DdlOptions;

/** 생성 중 경고(§6.8 제약명 축약, §6.3 대체 타입). 검증기 경고(§5.7)와 합쳐 응답·파일 요약에 실린다. */
export interface GenIssue {
  code: 'W_CONSTRAINT_NM_SHORTENED' | 'W_TYPE_OVERFLOW' | 'W_VARCHAR_BYTES';
  message: string;
  columnNm?: string;
}

export interface Rendered {
  sql: string;
  warnings: GenIssue[];
}

export interface DdlDialect {
  id(): Dialect;
  identifierMaxLength(): number;
  /** 대소문자 규칙 + 필요 시 인용(§6.4). 렌더링 직전 `^[A-Z][A-Z0-9_]*$` 재검사 — 위반이면 UnsafeIdentifierError. */
  identifier(name: string, opts: IdentifierOpts): string;
  /** 스키마명이 있으면 `schema.name`. */
  qualifiedName(name: string, opts: RenderOpts): string;
  mapType(type: StdType, length: number | null, scale: number | null): MappedType;
  /** 문자열 리터럴(§6.5): `'` → `''`, 개행·탭·제어 문자 → 공백 1개. */
  literal(text: string): string;
  /** DEFAULT 식(§6.6). 없으면 undefined. */
  renderDefault(spec: DefaultSpec, colType: StdType | null): string | undefined;
  /** `NAME TYPE [NOT NULL] [DEFAULT]`(속성 순서는 방언 YAML `columnAttributeOrder`). widths는 열 정렬 폭. */
  columnDefinition(col: ColumnModel, opts: RenderOpts, widths: ColumnWidths): string;
  /** CREATE TABLE 본문 + PK 제약 + CHECK(코드성 컬럼, D14). */
  createTable(table: TableModel, opts: RenderOpts): Rendered;
  /** COMMENT ON TABLE/COLUMN(PostgreSQL·Oracle). */
  comments(table: TableModel, opts: RenderOpts): string[];
  /** MySQL 인라인 COMMENT — PostgreSQL은 없음. */
  inlineComment(text: string): string | undefined;
  dropTable(name: string, ifExists: boolean, opts: RenderOpts): string;
  /** `[D14]` CHECK 옵션: `CONSTRAINT CK_{TBL}_{COL} CHECK ({COL} IN ('01', '02'))`. 활성 코드가 없으면 undefined. */
  checkConstraint(
    table: TableModel,
    col: ColumnModel,
    codes: CodeSummary,
    opts: RenderOpts,
  ): Rendered | undefined;
  reservedWords(): ReadonlySet<string>;
  terminator(): string;
  blockTerminator(): string;
}

export interface ColumnWidths {
  name: number;
  type: number;
}

export class UnsafeIdentifierError extends Error {
  override name = 'UnsafeIdentifierError';
  constructor(readonly identifier: string) {
    super(`식별자 검증 실패(렌더링 중단): ${JSON.stringify(identifier)}`);
  }
}

/** §6.4 대소문자·인용. 식별자 정규식을 통과하지 못하면 생성 중단(인젝션 방지, §12.2). */
export function renderIdentifier(name: string, opts: IdentifierOpts, quote: string): string {
  if (!IDENTIFIER_RE.test(name)) throw new UnsafeIdentifierError(name);
  const cased = opts.identifierCase === 'LOWER' ? name.toLowerCase() : name;
  return opts.quoteIdentifiers ? `${quote}${cased}${quote}` : cased;
}

/** §6.5 리터럴 본문 정리: 개행·탭(연속 포함) → 공백 1개, 그 밖의 제어 문자 → 공백(NUL 등 실행 실패 방지). */
export function flattenText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ');
}

/**
 * 제약명(§6.8): `{PREFIX}_{BASE}`가 방언 길이를 넘으면 `{PREFIX}_` + BASE 앞 24자 + 해시 4자로 축약하고 경고한다.
 * 해시는 원래 이름의 SHA-1 앞 4자리(대문자 16진) — 같은 입력이면 같은 이름(골든 파일 안정).
 */
export function constraintName(
  prefix: 'PK' | 'CK',
  base: string,
  max: number,
): { name: string; shortened: boolean } {
  const full = `${prefix}_${base}`;
  if (full.length <= max) return { name: full, shortened: false };
  const hash = createHash('sha1').update(full).digest('hex').slice(0, 4).toUpperCase();
  return { name: `${prefix}_${base.slice(0, 24)}${hash}`, shortened: true };
}

/** 코멘트 본문(§6.5·§6.7): 컬럼 코멘트 → 없으면 논리명, COMMENT_SUMMARY면 `(biz/cls: 01 계획, 02 진행 …)`(활성 최대 10, 초과 `…`). */
export function columnCommentText(col: ColumnModel, style: DdlOptions['codeColumnStyle']): string {
  const base = col.colComment?.trim() || col.logicalNm;
  const ref = col.codeClsRef;
  if (style !== 'COMMENT_SUMMARY' || !ref) return base;
  const list = ref.codes.slice(0, DDL_CODE_SUMMARY_MAX).map((c) => `${c.code} ${c.codeNm}`);
  if (ref.codes.length > DDL_CODE_SUMMARY_MAX) list.push('…');
  const key = `${ref.bizCd}/${ref.codeCls}`;
  return list.length > 0 ? `${base}(${key}: ${list.join(', ')})` : `${base}(${key})`;
}
