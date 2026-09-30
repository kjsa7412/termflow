import {
  checkStdTypeParts,
  DIALECTS,
  DIALECT_IDENTIFIER_MAX,
  formatValidationMessage,
  IDENTIFIER_RE,
  stdTypeProblemIssue,
  type Dialect,
  type ValidationCode,
  type ValidationIssue,
} from '@termflow/shared';
import { classifyDefault } from './defaults.js';
import type { ColumnModel, TableModel } from './model.js';
import { isReserved } from './reserved-words.js';
import { typeMapping } from './type-mapping.js';

/**
 * TableValidator 코어(설계서 §5.7 — 저장 전 서버 검증 · DDL 생성 시 재검증, T7.6 → 단계 8 저장 검증 T8.3이 같은 모듈).
 * E = 오류(저장·DDL 생성 차단), W = 경고(DDL 응답에 동봉). 방언 길이·예약어는 **기본 방언이면 E, 다른 방언이면 W**.
 * 순수 함수(DB 없음) — 프로젝트 문맥(접미어 집합·다른 테이블명·용어 상태)은 호출자가 ctx로 준다.
 * 409 계열(E_VERSION_CONFLICT·E_TABLE_FINAL·E_PROJECT_READONLY)은 서비스가 판정한다.
 */
export interface TermHint {
  /** 조각 중 PENDING·REJECTED 용어(한글). */
  pending?: string[];
  rejected?: string[];
  /** 재분절 결과 물리명(저장값과 다르면 W_TERM_CHANGED). */
  resegmented?: string | null;
}

export interface ValidateContext {
  /** 프로젝트 기본 방언(E 판정 기준). */
  dialect: Dialect;
  /** true면 예약어 판정 생략(인용 식별자는 통과, §6.4). */
  quoteIdentifiers?: boolean;
  /** 프로젝트 도메인분류 접미어 집합. 주지 않으면 W_SUFFIX_UNREGISTERED 판정 생략. */
  suffixes?: ReadonlySet<string>;
  /** 같은 프로젝트의 다른 테이블 물리명(E_TABLE_NM_DUP). */
  otherTableNames?: ReadonlySet<string>;
  /** 용어 상태·재분절(W_TERM_PENDING·REJECTED·CHANGED) — 자동완성 엔진(`columnTermHint`, T9.9)이 채운다. */
  termHints?: (col: ColumnModel, index: number) => TermHint | undefined;
}

export interface ValidationResult {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

type Params = Record<string, string | number>;
const DIALECT_LABEL: Record<Dialect, string> = {
  POSTGRESQL: 'PostgreSQL',
  ORACLE: 'Oracle',
  MYSQL: 'MySQL',
};
const blank = (v: string | null | undefined) => v === null || v === undefined || v.trim() === '';

/** 물리명 접미어: 마지막 `_` 조각의 끝 숫자 제거(L1 7단계 — 숫자 조각은 앞 조각에 붙는다, §5.2). */
export function physicalSuffix(physicalNm: string): string | null {
  const last = physicalNm.split('_').pop() ?? '';
  const s = last.replace(/\d+$/, '');
  return s === '' ? null : s;
}

export function validateTable(table: TableModel, ctx: ValidateContext): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const others = DIALECTS.filter((d) => d !== ctx.dialect);
  const tableRef = {
    ...(table.tableId !== null ? { tableId: table.tableId } : {}),
    tableNm: table.tableNm,
  };
  const push = (
    code: ValidationCode,
    base: Omit<ValidationIssue, 'code' | 'message'>,
    params: Params = {},
    message?: string,
  ) => {
    const issue: ValidationIssue = {
      code,
      ...base,
      ...tableRef,
      message: message ?? formatValidationMessage(code, params),
    };
    (code.startsWith('E_') ? errors : warnings).push(issue);
  };

  /** 형식 통과한 식별자의 길이·예약어(기본 방언 E, 다른 방언 W). */
  const identifierRules = (name: string, base: Omit<ValidationIssue, 'code' | 'message'>) => {
    const max = DIALECT_IDENTIFIER_MAX[ctx.dialect];
    if (name.length > max) push('E_PHYS_LEN', base, { max, dialect: DIALECT_LABEL[ctx.dialect] });
    for (const d of others) {
      const m = DIALECT_IDENTIFIER_MAX[d];
      if (name.length > m) push('W_LEN_OTHER_DIALECT', base, { max: m, dialect: DIALECT_LABEL[d] });
    }
    if (ctx.quoteIdentifiers) return;
    if (isReserved(ctx.dialect, name))
      push('E_RESERVED', base, { name, dialect: DIALECT_LABEL[ctx.dialect] });
    for (const d of others) {
      if (isReserved(d, name)) push('W_RESERVED_OTHER', base, { name, dialect: DIALECT_LABEL[d] });
    }
  };

  // ── 테이블 ────────────────────────────────────────────────────────
  const tbl = { target: 'table' as const };
  if (table.bizAreaId === null) push('E_BIZ_AREA_REQUIRED', { ...tbl, field: 'bizAreaId' });
  if (!IDENTIFIER_RE.test(table.tableNm)) {
    push('E_PHYS_FORMAT', { ...tbl, field: 'tableNm' });
  } else {
    identifierRules(table.tableNm, { ...tbl, field: 'tableNm' });
    if (ctx.otherTableNames?.has(table.tableNm))
      push('E_TABLE_NM_DUP', { ...tbl, field: 'tableNm' });
    if (table.tablePrefix && !table.tableNm.startsWith(table.tablePrefix)) {
      push(
        'W_PREFIX_MISMATCH',
        { ...tbl, field: 'tableNm' },
        {
          bizCd: table.bizCd ?? '',
          prefix: table.tablePrefix,
        },
      );
    }
  }
  if (!table.columns.some((c) => c.isPk)) push('W_PK_NONE', tbl);

  // ── 컬럼 ──────────────────────────────────────────────────────────
  const firstRow = new Map<string, number>();
  const bytesOver = typeMapping('ORACLE').types.VARCHAR.warnBytesOver;
  table.columns.forEach((c, i) => {
    const base = {
      target: 'column' as const,
      rowIndex: i,
      columnId: c.columnId,
      ...(blank(c.physicalNm) ? {} : { columnNm: c.physicalNm }),
    };
    if (blank(c.logicalNm)) push('E_LOGICAL_EMPTY', { ...base, field: 'logicalNm' });
    const phys = { ...base, field: 'physicalNm' };
    let physOk = false;
    if (blank(c.physicalNm)) {
      push('E_PHYS_EMPTY', phys);
    } else if (!IDENTIFIER_RE.test(c.physicalNm)) {
      push('E_PHYS_FORMAT', phys);
    } else {
      physOk = true;
      const prev = firstRow.get(c.physicalNm);
      if (prev !== undefined)
        push('E_PHYS_DUP', phys, { physicalNm: c.physicalNm, rowNo: prev + 1 });
      else firstRow.set(c.physicalNm, i);
      identifierRules(c.physicalNm, phys);
    }

    const type = { ...base, field: 'dataType' };
    if (c.dataType === null) {
      push('E_TYPE_MISSING', type);
    } else {
      const p = checkStdTypeParts(c.dataType, c.dataLength, c.dataScale);
      if (p) {
        const issue = stdTypeProblemIssue(p, c.dataType);
        push(issue.code, { ...base, field: 'dataLength' }, {}, issue.message);
      }
      if (c.dataType === 'VARCHAR' && bytesOver !== undefined && (c.dataLength ?? 0) > bytesOver)
        push('W_VARCHAR_BYTES', type);
    }
    if (c.isPk && c.isNullable) push('E_PK_NULLABLE', { ...base, field: 'isNullable' });

    if (c.matchType === 'UNREGISTERED' || c.physicalNm.includes('?'))
      push('W_TERM_UNREGISTERED', phys);
    const hint = ctx.termHints?.(c, i);
    for (const t of hint?.pending ?? []) push('W_TERM_PENDING', base, { termKor: t });
    for (const t of hint?.rejected ?? []) push('W_TERM_REJECTED', base, { termKor: t });
    if (hint?.resegmented && hint.resegmented !== c.physicalNm) {
      push('W_TERM_CHANGED', phys, { before: c.physicalNm, after: hint.resegmented });
    }

    // 기본컬럼(defaultColId)은 기본컬럼 세트 정의가 타입·물리명의 기준 → 도메인 타입 비교·접미어 판정 제외(CR-06 C5)
    const isDefaultCol = c.defaultColId !== null;
    if (c.domain) {
      const d = c.domain;
      if (
        !isDefaultCol &&
        d.colType !== null &&
        (d.colType !== c.dataType || d.colLength !== c.dataLength || d.colScale !== c.dataScale)
      ) {
        push('W_DOMAIN_TYPE_CHANGED', type);
      }
      if (d.reviewYn) push('W_DOMAIN_REVIEW', base);
    }
    if (physOk && ctx.suffixes && !isDefaultCol) {
      const s = physicalSuffix(c.physicalNm);
      if (s !== null && !ctx.suffixes.has(s)) push('W_SUFFIX_UNREGISTERED', phys, { suffix: s });
    }
    if (c.matchType === 'CODE' && c.codeClsId === null) push('W_CODE_CLS_MISSING', base);
    const dflt = classifyDefault(c.defaultVal);
    if (dflt.kind === 'STRING' && dflt.looksLikeFunction) {
      push('W_DEFAULT_AS_STRING', { ...base, field: 'defaultVal' }, { defaultVal: dflt.value });
    }
    if (blank(c.colComment)) push('W_COMMENT_EMPTY', { ...base, field: 'colComment' });
  });
  return { errors, warnings };
}
