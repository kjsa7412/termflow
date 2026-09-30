import { describe, expect, it } from 'vitest';
import type { ColumnInput } from '@termflow/shared';
import {
  changeSummaryText,
  planColumnDiff,
  type ExistingColumn,
} from '../../src/table/column-diff.js';
import { copyName } from '../../src/table/table-clone.service.js';
import { normalizeInput } from '../../src/table/table.service.js';
import { readSnapshot } from '../../src/table/table-detail.loader.js';

// T8.2 저장 diff(§8.2): 삽입·수정·삭제·순서·덮어쓰기 시 남이 지운 ID
const col = (
  id: number,
  seq: number,
  nm: string,
  over: Partial<ExistingColumn> = {},
): ExistingColumn => ({
  columnId: id,
  colSeq: seq,
  logicalNm: `${nm} 논리`,
  physicalNm: nm,
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
  ...over,
});
const inp = (c: ExistingColumn, over: Partial<ColumnInput> = {}): ColumnInput => {
  const { colSeq: _s, ...rest } = c;
  return { ...rest, ...over };
};
const fresh = (nm: string): ColumnInput => ({ ...inp(col(0, 0, nm)), columnId: null });
const EXIST = [col(11, 1, 'A'), col(12, 2, 'B'), col(13, 3, 'C')];

describe('planColumnDiff(§8.2)', () => {
  it('변경 없음: 전부 keep, 요약 +0 ~0 -0', () => {
    const p = planColumnDiff(
      EXIST,
      EXIST.map((c) => inp(c)),
    );
    expect(p.ops.map((o) => o.kind)).toEqual(['keep', 'keep', 'keep']);
    expect(p.deletes).toEqual([]);
    expect(p.summary).toEqual({ ins: 0, upd: 0, del: 0, reordered: false });
    expect(changeSummaryText(p.summary)).toBe('컬럼 +0 ~0 -0');
  });

  it('삽입(ID 없음) 2 · 수정 1 · 삭제 1 → "컬럼 +2 ~1 -1", 새 행은 표시 순서의 seq', () => {
    const p = planColumnDiff(EXIST, [
      inp(EXIST[0]!, { dataLength: 30 }),
      fresh('D'),
      inp(EXIST[1]!),
      fresh('E'),
    ]);
    expect(p.ops.map((o) => [o.kind, o.seq])).toEqual([
      ['update', 1],
      ['insert', 2],
      ['reseq', 3],
      ['insert', 4],
    ]);
    expect(p.deletes).toEqual([13]);
    expect(p.summary).toEqual({ ins: 2, upd: 1, del: 1, reordered: true });
    expect(changeSummaryText(p.summary)).toBe('컬럼 +2 ~1 -1, 순서 변경');
  });

  it('순서만 변경: reseq(감사 미갱신 경로), 수정 0', () => {
    const p = planColumnDiff(EXIST, [inp(EXIST[2]!), inp(EXIST[0]!), inp(EXIST[1]!)]);
    expect(p.ops.map((o) => o.kind)).toEqual(['reseq', 'reseq', 'reseq']);
    expect(p.summary).toEqual({ ins: 0, upd: 0, del: 0, reordered: true });
    expect(changeSummaryText(p.summary, true)).toBe('컬럼 +0 ~0 -0, 순서 변경, 테이블 정보 변경');
  });

  it('필드마다 변경 판정(logical/physical/pk/type/len/scale/null/default/comment/domain/code/defaultCol/matchType)', () => {
    const cases: Partial<ColumnInput>[] = [
      { logicalNm: 'x' },
      { physicalNm: 'X' },
      { isPk: true },
      { dataType: 'TEXT' },
      { dataLength: 99 },
      { dataScale: 1 },
      { isNullable: false },
      { defaultVal: "'N'" },
      { colComment: '코멘트' },
      { domainId: 5 },
      { codeClsId: 6 },
      { defaultColId: 7 },
      { matchType: 'EXACT' },
    ];
    for (const over of cases) {
      const p = planColumnDiff([EXIST[0]!], [inp(EXIST[0]!, over)]);
      expect(p.ops[0]!.kind, JSON.stringify(over)).toBe('update');
    }
  });

  it('덮어쓰기: 남이 지운 columnId(기존에 없음) → 신규 삽입, 다른 테이블 ID도 신규', () => {
    const p = planColumnDiff(
      [EXIST[0]!],
      [inp(EXIST[0]!), inp(EXIST[1]!), { ...fresh('Z'), columnId: 999 }],
    );
    expect(p.ops.map((o) => o.kind)).toEqual(['keep', 'insert', 'insert']);
    expect(p.summary.ins).toBe(2);
    expect(p.deletes).toEqual([]);
  });

  it('같은 요청 안의 중복 columnId: 두 번째는 신규', () => {
    const p = planColumnDiff(EXIST, [inp(EXIST[0]!), inp(EXIST[0]!, { physicalNm: 'A2' })]);
    expect(p.ops.map((o) => o.kind)).toEqual(['keep', 'insert']);
    expect(p.deletes).toEqual([12, 13]);
  });

  it('전부 삭제·빈 테이블 신규', () => {
    expect(planColumnDiff(EXIST, []).summary).toEqual({ ins: 0, upd: 0, del: 3, reordered: false });
    expect(planColumnDiff([], [fresh('A')]).summary).toEqual({
      ins: 1,
      upd: 0,
      del: 0,
      reordered: false,
    });
  });
});

describe('저장 정규화·복제 이름·스냅샷 읽기', () => {
  it('물리명 대문자·trim, PK는 NOT NULL로 자동 보정(§5.5·§5.7)', () => {
    const n = normalizeInput({
      table: { bizAreaId: 1, tableNm: ' rp_test ', tableLogicalNm: '시험', description: null },
      columns: [{ ...fresh('a'), physicalNm: ' rsch_id ', isPk: true, isNullable: true }],
    });
    expect(n.table.tableNm).toBe('RP_TEST');
    expect(n.columns[0]).toMatchObject({ physicalNm: 'RSCH_ID', isPk: true, isNullable: false });
  });

  it('복제 이름: _COPY → _COPY2 → _COPY3, 식별자 상한을 넘으면 원본을 자른다', () => {
    expect(copyName('RP_A', new Set(), 63)).toBe('RP_A_COPY');
    expect(copyName('RP_A', new Set(['RP_A_COPY']), 63)).toBe('RP_A_COPY2');
    expect(copyName('RP_A', new Set(['RP_A_COPY', 'RP_A_COPY2']), 63)).toBe('RP_A_COPY3');
    const long = 'X'.repeat(63);
    const n = copyName(long, new Set(), 63);
    expect(n).toHaveLength(63);
    expect(n.endsWith('_COPY')).toBe(true);
  });

  it('스냅샷 schemaVersion: 없으면 1판으로 보고 빠진 필드 기본값, 모르는 판은 오류', () => {
    const s = readSnapshot({
      table: { tableId: 1 },
      columns: [{ physicalNm: 'A' }],
      action: 'MIGRATE',
    });
    expect(s.schemaVersion).toBe(1);
    expect(s.columns[0]).toMatchObject({
      physicalNm: 'A',
      colSeq: 1,
      isNullable: true,
      matchType: 'MANUAL',
      columnId: null,
    });
    expect(() => readSnapshot({ schemaVersion: 2 })).toThrow(/schemaVersion/);
  });
});
