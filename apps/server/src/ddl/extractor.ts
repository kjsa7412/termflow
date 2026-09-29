import type { DdlOptions } from '@termflow/shared';
import { classifyDefault } from './defaults.js';
import type { DdlDialect } from './dialect.js';
import type { TableModel } from './model.js';

/**
 * 정보 추출(탭 구분 텍스트, 설계서 §6.11) — 엑셀 붙여넣기용 테이블 정의서. 헤더 1행 + 컬럼 행, 테이블 사이 빈 줄 1개.
 * PK·NULL허용은 Y/N, 타입·기본값은 선택 방언의 표현, 코드구분은 `RP/040 진행상태`, 도메인은 논리명. 값의 탭·개행은 공백으로.
 */
export const EXTRACT_HEADER = [
  '업무구분',
  '테이블물리명',
  '테이블논리명',
  '순번',
  '컬럼논리명',
  '컬럼물리명',
  'PK',
  '타입',
  'NULL허용',
  '기본값',
  '코멘트',
  '코드구분',
  '도메인',
] as const;

const cell = (v: string | number | null | undefined): string =>
  v === null || v === undefined ? '' : String(v).replace(/[\t\r\n]+/g, ' ');

export interface ExtractResult {
  text: string;
  rowCnt: number;
}

export function extractTables(
  d: DdlDialect,
  tables: readonly TableModel[],
  opts: Pick<DdlOptions, 'lineEnding'>,
): ExtractResult {
  const lines: string[] = [EXTRACT_HEADER.join('\t')];
  let rowCnt = 0;
  tables.forEach((t, ti) => {
    if (ti > 0) lines.push('');
    t.columns.forEach((c, i) => {
      rowCnt++;
      const type = c.dataType ? d.mapType(c.dataType, c.dataLength, c.dataScale).sql : '';
      const ref = c.codeClsRef;
      lines.push(
        [
          t.bizCd,
          t.tableNm,
          t.logicalNm,
          i + 1,
          c.logicalNm,
          c.physicalNm,
          c.isPk ? 'Y' : 'N',
          type,
          c.isNullable && !c.isPk ? 'Y' : 'N',
          d.renderDefault(classifyDefault(c.defaultVal), c.dataType) ?? '',
          c.colComment?.trim() || c.logicalNm,
          ref ? `${ref.bizCd}/${ref.codeCls} ${ref.codeClsNm}` : '',
          c.domain?.logicalNm ?? '',
        ]
          .map(cell)
          .join('\t'),
      );
    });
  });
  const lf = `${lines.join('\n')}\n`;
  return { text: opts.lineEnding === 'CRLF' ? lf.replaceAll('\n', '\r\n') : lf, rowCnt };
}
