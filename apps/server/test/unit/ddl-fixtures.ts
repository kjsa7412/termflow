import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ColumnModel, DdlMeta, TableModel } from '../../src/ddl/model.js';

/** DDL 단위 테스트 공용 모델 빌더. */
export function col(over: Partial<ColumnModel> & Pick<ColumnModel, 'physicalNm'>): ColumnModel {
  return {
    columnId: null,
    colSeq: 1,
    logicalNm: over.physicalNm,
    isPk: false,
    dataType: 'VARCHAR',
    dataLength: 20,
    dataScale: null,
    isNullable: true,
    defaultVal: null,
    colComment: over.logicalNm ?? over.physicalNm,
    domainId: null,
    codeClsId: null,
    defaultColId: null,
    matchType: 'MANUAL',
    domain: null,
    codeClsRef: null,
    ...over,
  };
}

export function table(
  over: Partial<TableModel> & Pick<TableModel, 'tableNm' | 'columns'>,
): TableModel {
  return {
    tableId: null,
    logicalNm: over.tableNm,
    description: null,
    bizAreaId: 1,
    bizCd: 'RP',
    bizNm: '연구과제',
    tablePrefix: 'RP_',
    status: 'FINAL',
    version: 1,
    ...over,
    columns: over.columns.map((c, i) => ({ ...c, colSeq: i + 1 })),
  };
}

/** §6.8 예시 헤더와 같은 메타. */
export const META_68: DdlMeta = {
  projectKey: 'RMS',
  projectNm: '연구관리시스템(이관)',
  generatedAt: '2026-09-28 14:00',
  generatedBy: 'hong',
};

/** §6.8 `RP_RSCH_PRJ_MAST`(8컬럼 축약, 코드값은 예시). */
export const RP_RSCH_PRJ_MAST_68: TableModel = table({
  tableNm: 'RP_RSCH_PRJ_MAST',
  logicalNm: '연구과제마스터',
  columns: [
    col({ physicalNm: 'WRK_MAST_ID', logicalNm: '업무마스터ID', isPk: true, isNullable: false }),
    col({ physicalNm: 'RSCH_PRJ_ID', logicalNm: '연구과제ID', isNullable: false }),
    col({
      physicalNm: 'PRGRS_STAT_CD',
      logicalNm: '진행상태코드',
      dataLength: 10,
      codeClsId: 40,
      matchType: 'CODE',
      codeClsRef: {
        codeClsId: 40,
        bizCd: 'RP',
        codeCls: 'RP040',
        codeClsNm: '진행상태',
        codes: [
          { code: '01', codeNm: '계획' },
          { code: '02', codeNm: '진행' },
          { code: '03', codeNm: '완료' },
        ],
      },
    }),
    col({
      physicalNm: 'END_YN',
      logicalNm: '종료여부',
      dataLength: 1,
      isNullable: false,
      defaultVal: 'N',
    }),
    col({ physicalNm: 'PRJ_NM', logicalNm: '과제명', dataLength: 30 }),
    col({
      physicalNm: 'EVL_CMTE_WGHTD_VAL',
      logicalNm: '평가위원회가중치',
      dataType: 'NUMERIC',
      dataLength: 6,
      dataScale: 2,
    }),
    col({
      physicalNm: 'FIRS_REG_DTS',
      logicalNm: '최초등록일시',
      dataType: 'TIMESTAMP',
      dataLength: 0,
      defaultVal: 'CURRENT_TIMESTAMP',
    }),
    col({ physicalNm: 'FINA_RGSRT_ID', logicalNm: '최종등록자ID' }),
  ],
});

const DOC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/02_설계서.md',
);

/** 설계서 §6.8의 첫 ```sql 블록(PostgreSQL 기본 옵션 예시). */
export function designExample68(): string {
  const doc = readFileSync(DOC, 'utf8').split('\r\n').join('\n');
  const sec = doc.slice(doc.indexOf('### 6.8'));
  const start = sec.indexOf('```sql\n') + '```sql\n'.length;
  return sec.slice(start, sec.indexOf('```', start));
}

/** 설계서 §6.3 매핑 표 행(표준 타입 → 방언별 셀 텍스트). */
export function designTypeTable(): { type: string; pg: string; oracle: string; mysql: string }[] {
  const doc = readFileSync(DOC, 'utf8').split('\r\n').join('\n');
  const sec = doc.slice(doc.indexOf('### 6.3'), doc.indexOf('### 6.4'));
  return sec
    .split('\n')
    .filter((l) => /^\| [A-Z]+(\(|\s)/.test(l) && !l.startsWith('| 표준 타입'))
    .map((l) => l.split('|').map((c) => c.trim()))
    .map((c) => ({ type: c[1]!, pg: c[3]!, oracle: c[4]!, mysql: c[5]! }));
}
