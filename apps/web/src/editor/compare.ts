import { typeText, type ColumnInput } from '@termflow/shared';

/**
 * 두 버전 나란히 비교(설계서 §8.1 충돌 병합 모달 · §8.3 이력 비교 · §8.7 임시저장 비교, 목업 14).
 * 정렬 키: 컬럼 ID 우선, 없으면 물리명(§8.1 "컬럼 ID·물리명 기준"). 행 단위 자동 병합은 2차.
 */
export type CompareColumn = Pick<
  ColumnInput,
  | 'columnId'
  | 'logicalNm'
  | 'physicalNm'
  | 'isPk'
  | 'dataType'
  | 'dataLength'
  | 'dataScale'
  | 'isNullable'
  | 'defaultVal'
  | 'colComment'
  | 'domainId'
  | 'codeClsId'
  | 'defaultColId'
>;

export type CompareKind = 'same' | 'chg' | 'left' | 'right';

export interface CompareRow {
  kind: CompareKind;
  /** 왼쪽(최신본·과거 버전) 순번(1부터), 없으면 null. */
  leftNo: number | null;
  rightNo: number | null;
  left: CompareColumn | null;
  right: CompareColumn | null;
  /** 바뀐 필드 라벨(chg). */
  changes: string[];
}

const LABELS: [keyof CompareColumn, string][] = [
  ['logicalNm', '논리명'],
  ['physicalNm', '물리명'],
  ['isPk', 'PK'],
  ['dataType', '타입'],
  ['dataLength', '길이'],
  ['dataScale', '스케일'],
  ['isNullable', 'NULL'],
  ['defaultVal', '기본값'],
  ['colComment', '코멘트'],
  ['domainId', '도메인'],
  ['codeClsId', '코드구분'],
  ['defaultColId', '기본컬럼'],
];

export function changedFields(a: CompareColumn, b: CompareColumn): string[] {
  const out: string[] = [];
  for (const [k, label] of LABELS) {
    if ((a[k] ?? null) !== (b[k] ?? null)) {
      if ((k === 'dataLength' || k === 'dataScale') && out.includes('타입')) continue;
      out.push(k === 'dataLength' || k === 'dataScale' ? '타입' : label);
    }
  }
  return [...new Set(out)];
}

/** 한 줄 요약: `RSCH_PRJ_ID VARCHAR(20) NOT NULL DEFAULT 0`. */
export function describe(c: CompareColumn): string {
  const t = typeText(c.dataType, c.dataLength, c.dataScale) ?? '(타입 없음)';
  return [
    c.physicalNm || '(물리명 없음)',
    t,
    c.isNullable ? null : 'NOT NULL',
    c.defaultVal ? `DEFAULT ${c.defaultVal}` : null,
  ]
    .filter(Boolean)
    .join(' ');
}

export function alignColumns(
  left: readonly CompareColumn[],
  right: readonly CompareColumn[],
): CompareRow[] {
  const used = new Set<number>();
  const findRight = (l: CompareColumn): number => {
    if (l.columnId !== null) {
      const i = right.findIndex((r, j) => !used.has(j) && r.columnId === l.columnId);
      if (i >= 0) return i;
    }
    return right.findIndex(
      (r, j) => !used.has(j) && r.physicalNm !== '' && r.physicalNm === l.physicalNm,
    );
  };
  const rows: CompareRow[] = [];
  const pairs = left.map((l, li) => {
    const ri = findRight(l);
    if (ri >= 0) used.add(ri);
    return { li, ri };
  });
  // 오른쪽에만 있는 행은 오른쪽 순서 위치(앞 짝 뒤)에 끼운다
  let lastRight = -1;
  const rightOnlyBefore = (limit: number) => {
    for (let j = lastRight + 1; j < limit; j++) {
      if (!used.has(j)) {
        used.add(j);
        rows.push({ kind: 'right', leftNo: null, rightNo: j + 1, left: null, right: right[j]!, changes: [] });
      }
    }
  };
  for (const { li, ri } of pairs) {
    const l = left[li]!;
    if (ri < 0) {
      rows.push({ kind: 'left', leftNo: li + 1, rightNo: null, left: l, right: null, changes: [] });
      continue;
    }
    rightOnlyBefore(ri);
    lastRight = Math.max(lastRight, ri);
    const r = right[ri]!;
    const changes = changedFields(l, r);
    rows.push({
      kind: changes.length === 0 ? 'same' : 'chg',
      leftNo: li + 1,
      rightNo: ri + 1,
      left: l,
      right: r,
      changes,
    });
  }
  lastRight = -1; // 순서가 엇갈려 건너뛴 오른쪽 전용 행까지 끝에 모은다
  rightOnlyBefore(right.length);
  return rows;
}

/** 차이 건수(동일 행 제외) — 충돌 모달 "변경 n건을 되돌린다". */
export const diffCount = (rows: readonly CompareRow[]) => rows.filter((r) => r.kind !== 'same').length;
