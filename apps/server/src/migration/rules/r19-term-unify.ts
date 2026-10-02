/**
 * R19 용어 기준 물리명 정정(CR-09, 설계서 §11.2): 승계 데이터가 용어사전과 다른 물리약어를 쓰던 두 쌍을 용어사전 기준으로 맞춘다.
 *  - 등록자 = RGSRT: 기본컬럼 `FIRS_REG_USER_ID` → `FIRS_RGSRT_ID`, `FINA_REG_USER_ID` → `FINA_RGSRT_ID`
 *    (RETAILV1 기본컬럼 세트 적재 시 · RMS 테이블 컬럼 적재 시 — 이름이 정확히 같은 컬럼만)
 *  - 마스터 = MAST: 테이블 물리명의 **끝 조각** `MST` → `MAST`(예 `RP_RSCH_PRJ_MST` → `RP_RSCH_PRJ_MAST`). 중간 조각·컬럼명은 바꾸지 않는다
 * 적용 지점: DEFAULT_COL(세트), TABLE(테이블·컬럼) — 새 적재는 처음부터 새 이름. 이미 적재된 DB는 TERM_UNIFY step이
 * 편집기 저장과 같은 서비스 경로로 정정한다. 대응표는 리포트 `cr09-rename-map.csv`(표준 헤더, rule R19).
 */
export const R19_RULE = 'R19';
export const R19_REPORT = 'cr09-rename-map';

/** 기본컬럼·테이블 컬럼 물리명 정정(이전 → 이후). */
export const R19_COLUMN_RENAMES: ReadonlyMap<string, string> = new Map([
  ['FIRS_REG_USER_ID', 'FIRS_RGSRT_ID'],
  ['FINA_REG_USER_ID', 'FINA_RGSRT_ID'],
]);

const TABLE_TAIL_RE = /_MST$/;

/** 컬럼 물리명(대문자 정규화 후)에 R19 적용. 대상이 아니면 그대로. */
export function r19ColumnName(physicalNm: string): string {
  return R19_COLUMN_RENAMES.get(physicalNm) ?? physicalNm;
}

/** 테이블 물리명(대문자 정규화 후)에 R19 적용: 끝 조각 MST → MAST. */
export function r19TableName(tableNm: string): string {
  return tableNm.replace(TABLE_TAIL_RE, '_MAST');
}

export interface RenameTable {
  oldNm: string;
  newNm: string;
  /** 이름이 바뀌는 컬럼만(원래 순서). */
  columns: { oldNm: string; newNm: string }[];
}

/**
 * 테이블·컬럼 이름 목록 → 이름이 바뀌는 항목만 모은 계획. 같은 테이블 안(컬럼)·테이블 사이(테이블명)에서 정정 결과가 기존 이름과
 * 겹치면 실패한다(자동 정정이 두 객체를 한 이름으로 합치지 않게).
 */
export function planRenames(tables: readonly { tableNm: string; columns: readonly string[] }[]): RenameTable[] {
  const names = new Set(tables.map((t) => t.tableNm));
  const out: RenameTable[] = [];
  const seenNew = new Map<string, string>();
  for (const t of tables) {
    const newNm = r19TableName(t.tableNm);
    if (newNm !== t.tableNm && names.has(newNm))
      throw new Error(`R19 테이블명 충돌: ${t.tableNm} → ${newNm}(이미 있음)`);
    const prev = seenNew.get(newNm);
    if (prev !== undefined) throw new Error(`R19 테이블명 충돌: ${prev}·${t.tableNm} → ${newNm}`);
    seenNew.set(newNm, t.tableNm);
    const cols = new Set(t.columns);
    const columns: RenameTable['columns'] = [];
    for (const c of t.columns) {
      const n = r19ColumnName(c);
      if (n === c) continue;
      if (cols.has(n)) throw new Error(`R19 컬럼명 충돌: ${t.tableNm}.${c} → ${n}(이미 있음)`);
      columns.push({ oldNm: c, newNm: n });
    }
    if (newNm !== t.tableNm || columns.length > 0) out.push({ oldNm: t.tableNm, newNm, columns });
  }
  return out;
}
