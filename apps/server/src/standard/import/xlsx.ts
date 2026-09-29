import ExcelJS from 'exceljs';
import { API_ERROR_CODES, IMPORT_ROWS_MAX } from '@termflow/shared';
import { ValidationProblem } from '../../common/problem/problem.exception.js';

/**
 * 엑셀(xlsx) 입출력(T6.9, 설계서 §9.4·§12.1·§12.2). 첫 시트만 읽고 1,000행마다 `setImmediate`로 이벤트 루프를
 * 양보한다(K9). 수식 셀은 계산 결과 값만 쓴다(수식 실행·저장 없음). 임시 파일을 만들지 않는다.
 */

export interface SheetColumn {
  key: string;
  label: string;
  required: boolean;
}

/** 업로드 파일 → 데이터 행(헤더 제외). 셀 값은 trim한 문자열, 빈 값은 null. */
export interface RawRow {
  rowNo: number;
  cells: Record<string, string | null>;
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const YIELD_EVERY = 1000;

/** xlsx = ZIP 컨테이너(매직 바이트 `PK\x03\x04`, §12.2 업로드). */
export function isXlsx(buf: Buffer): boolean {
  return buf.length > 4 && ZIP_MAGIC.every((b, i) => buf[i] === b);
}

function fileError(detail: string, code = 'E_IMPORT_FILE'): ValidationProblem {
  return new ValidationProblem([{ code, target: 'all', message: detail }], [], detail);
}

/** 셀 값 → 문자열(수식은 결과, 리치 텍스트는 텍스트 연결, 날짜는 YYYY-MM-DD). */
export function cellText(v: ExcelJS.CellValue | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (typeof v === 'boolean') return v ? 'Y' : 'N';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if (Array.isArray(o['richText']))
      return cellText((o['richText'] as { text: string }[]).map((t) => t.text).join(''));
    if ('result' in o) return cellText(o['result'] as ExcelJS.CellValue);
    if ('formula' in o || 'sharedFormula' in o) return null;
    if (typeof o['text'] === 'string') return cellText(o['text']);
    if ('error' in o) return null;
  }
  return null;
}

const headerKey = (s: string | null) => (s ?? '').replace(/\*/g, '').replace(/\s+/g, '').trim();

/**
 * 첫 시트를 읽는다. 첫 비어 있지 않은 행은 헤더(템플릿과 같은 순서, `*`·공백 무시), 빈 행은 건너뛴다.
 * 헤더가 다르면 422 `E_IMPORT_HEADER`, 데이터 행이 상한을 넘으면 422 `E_IMPORT_ROWS_MAX`.
 */
export async function readSheet(
  buf: Buffer,
  columns: readonly SheetColumn[],
  maxRows = IMPORT_ROWS_MAX,
): Promise<RawRow[]> {
  if (!isXlsx(buf)) throw fileError(API_ERROR_CODES.E_IMPORT_FILE);
  // exceljs 4.4 스트리밍 WorkbookReader는 워크시트가 sharedStrings.xml보다 앞에 있는 파일(exceljs·Excel 생성 파일 대부분)의
  // 공유 문자열을 풀지 못하고({sharedString: n}) 임시 파일도 만든다 → 이미 메모리에 있는 업로드 버퍼(≤ 상한 MB)를 전체 로드하고,
  // 행 순회는 1,000행마다 양보한다(CR-05 C6).
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch (e) {
    throw fileError(
      `${API_ERROR_CODES.E_IMPORT_FILE}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const ws = wb.worksheets[0];
  const out: RawRow[] = [];
  let header: string[] | null = null;
  if (ws) {
    const last = ws.actualRowCount === 0 ? 0 : (ws.lastRow?.number ?? 0);
    for (let n = 1; n <= last; n++) {
      if (n % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
      const row = ws.getRow(n);
      const cells = columns.map((_, i) => cellText(row.getCell(i + 1).value));
      if (header === null) {
        if (cells.every((c) => c === null)) continue; // 헤더 앞 빈 행
        header = cells.map(headerKey);
        const expected = columns.map((c) => headerKey(c.label));
        if (header.join('|') !== expected.join('|')) {
          throw fileError(
            `${API_ERROR_CODES.E_IMPORT_HEADER}: 기대 [${columns.map((c) => c.label).join(', ')}], 파일 [${header.join(', ')}]`,
            'E_IMPORT_HEADER',
          );
        }
        continue;
      }
      if (cells.every((c) => c === null)) continue;
      if (out.length >= maxRows) {
        throw fileError(
          `${API_ERROR_CODES.E_IMPORT_ROWS_MAX}: 최대 ${maxRows.toLocaleString('ko-KR')}행`,
          'E_IMPORT_ROWS_MAX',
        );
      }
      out.push({
        rowNo: n,
        cells: Object.fromEntries(columns.map((c, i) => [c.key, cells[i] ?? null])),
      });
    }
  }
  if (header === null)
    throw fileError(`${API_ERROR_CODES.E_IMPORT_HEADER}: 헤더 행이 없습니다`, 'E_IMPORT_HEADER');
  if (out.length === 0) throw fileError(API_ERROR_CODES.E_IMPORT_EMPTY, 'E_IMPORT_EMPTY');
  return out;
}

/** 템플릿 xlsx(§9.4: 헤더 1행 + 예시 1행, 필수 열 굵게 + 연한 배경, 첫 행 고정). */
export async function buildTemplate(
  sheetName: string,
  columns: readonly SheetColumn[],
  example: readonly (string | number | null)[],
  notes: readonly string[] = [],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TermFlow';
  const ws = wb.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c) => ({
    header: c.label,
    key: c.key,
    width: Math.max(12, c.label.length * 2 + 4),
  }));
  const head = ws.getRow(1);
  columns.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.font = { bold: c.required };
    if (c.required)
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF1FB' } };
  });
  ws.addRow([...example]);
  if (notes.length > 0) {
    const info = wb.addWorksheet('안내');
    info.getColumn(1).width = 100;
    info.addRow([
      '굵은 열은 필수입니다. 첫 시트의 첫 행(헤더)은 바꾸지 마세요. 예시 행은 지우고 입력하세요.',
    ]);
    for (const n of notes) info.addRow([n]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
