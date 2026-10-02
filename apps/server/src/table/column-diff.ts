import type { ColumnInput, MatchType, StdType } from '@termflow/shared';

/**
 * 저장 diff 알고리즘(설계서 §8.2, L6 "전체 삭제 후 재삽입" 대체) — DB 없는 순수 함수. 서비스가 계획(plan)을 실행한다.
 *  - incoming = 편집기 표시 순서(기본컬럼 영역은 뒤), seq = idx + 1
 *  - columnId가 이 테이블의 기존 행이면: 필드가 바뀌면 update(updated_* 갱신), 순서만 바뀌면 reseq(감사 미갱신), 같으면 keep
 *  - columnId 없음 · 남이 지운 ID(덮어쓰기·복원) · 다른 테이블 ID · 같은 요청 안의 중복 ID → insert(새 ID)
 *  - incoming에 없는 기존 행 → delete
 */
export interface ExistingColumn {
  columnId: number;
  colSeq: number;
  logicalNm: string;
  physicalNm: string;
  isPk: boolean;
  dataType: StdType | null;
  dataLength: number | null;
  dataScale: number | null;
  isNullable: boolean;
  defaultVal: string | null;
  colComment: string | null;
  domainId: number | null;
  codeClsId: number | null;
  defaultColId: number | null;
  matchType: MatchType;
}

export type IncomingColumn = ColumnInput;

export type ColumnOp =
  | { kind: 'insert'; index: number; seq: number; input: IncomingColumn }
  | { kind: 'update'; index: number; seq: number; columnId: number; input: IncomingColumn }
  | { kind: 'reseq'; index: number; seq: number; columnId: number }
  | { kind: 'keep'; index: number; seq: number; columnId: number };

export interface DiffSummary {
  ins: number;
  upd: number;
  del: number;
  reordered: boolean;
}

export interface DiffPlan {
  /** incoming 순서와 같은 길이·순서. */
  ops: ColumnOp[];
  deletes: number[];
  summary: DiffSummary;
}

/** §8.2 fieldsChanged: logical/physical/pk/type/len/scale/nullable/default/comment/domain/codeCls/defaultCol/matchType. */
const FIELDS = [
  'logicalNm',
  'physicalNm',
  'isPk',
  'dataType',
  'dataLength',
  'dataScale',
  'isNullable',
  'defaultVal',
  'colComment',
  'domainId',
  'codeClsId',
  'defaultColId',
  'matchType',
] as const satisfies readonly (keyof ExistingColumn & keyof IncomingColumn)[];

export function fieldsChanged(row: ExistingColumn, c: IncomingColumn): boolean {
  return FIELDS.some((f) => row[f] !== c[f]);
}

export function planColumnDiff(
  existing: readonly ExistingColumn[],
  incoming: readonly IncomingColumn[],
): DiffPlan {
  const byId = new Map(existing.map((e) => [e.columnId, e]));
  const seen = new Set<number>();
  const summary: DiffSummary = { ins: 0, upd: 0, del: 0, reordered: false };
  // "순서 변경" = 기존 컬럼끼리의 앞뒤가 바뀐 경우만. 끼워 넣기·삭제로 순번만 밀린 것(reseq)은 아니다(CR-15 C14)
  let lastOldSeq = 0;
  const ops = incoming.map((c, index): ColumnOp => {
    const seq = index + 1;
    const row = c.columnId !== null ? byId.get(c.columnId) : undefined;
    if (row && !seen.has(row.columnId)) {
      seen.add(row.columnId);
      if (row.colSeq < lastOldSeq) summary.reordered = true;
      lastOldSeq = Math.max(lastOldSeq, row.colSeq);
      if (fieldsChanged(row, c)) {
        summary.upd++;
        return { kind: 'update', index, seq, columnId: row.columnId, input: c };
      }
      if (row.colSeq !== seq) {
        return { kind: 'reseq', index, seq, columnId: row.columnId };
      }
      return { kind: 'keep', index, seq, columnId: row.columnId };
    }
    summary.ins++;
    return { kind: 'insert', index, seq, input: c };
  });
  const deletes = existing.filter((e) => !seen.has(e.columnId)).map((e) => e.columnId);
  summary.del = deletes.length;
  return { ops, deletes, summary };
}

/** 이력 요약 "컬럼 +2 ~1 -0"(§8.3) + ", 순서 변경" + ", 테이블 정보 변경". */
export function changeSummaryText(s: DiffSummary, headerChanged = false): string {
  let t = `컬럼 +${s.ins} ~${s.upd} -${s.del}`;
  if (s.reordered) t += ', 순서 변경';
  if (headerChanged) t += ', 테이블 정보 변경';
  return t;
}
