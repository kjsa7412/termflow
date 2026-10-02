import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 동봉 기본 표준 템플릿 CSV(CR-16 C3, `apps/server/resources/templates/<키 소문자>/`). UTF-8(BOM 허용),
 * 첫 줄 머리글 고정. 엑셀로 열어 고칠 수 있게 머리글은 일괄 등록 화면과 같은 한글 이름을 쓴다.
 */

export interface TplBizArea {
  bizCd: string;
  bizNm: string;
  tablePrefix: string;
  sortNo: number;
  description: string;
}

export interface TplTerm {
  termKor: string;
  termPhysical: string;
  description: string;
  synonymRef: string;
}

export interface TplDomainCls {
  suffix: string;
  clsNm: string;
  colType: string;
  colLength: number | null;
  colScale: number | null;
  description: string;
}

export interface TplDomain {
  parts: string[];
  logicalNm: string;
  physicalNm: string;
  suffix: string;
  typeText: string;
}

export interface TplCode {
  bizCd: string;
  codeCls: string;
  codeClsNm: string;
  codeClsDesc: string;
  code: string;
  codeNm: string;
  sortOrder: number;
}

export interface TplDefaultCol {
  setNm: string;
  setDesc: string;
  isDefault: boolean;
  colSeq: number;
  logicalNm: string;
  physicalNm: string;
  isPk: boolean;
  dataType: string;
  dataLength: number | null;
  dataScale: number | null;
  isNullable: boolean;
  defaultVal: string | null;
  colComment: string;
}

export interface TemplateData {
  bizAreas: TplBizArea[];
  terms: TplTerm[];
  domainClasses: TplDomainCls[];
  domains: TplDomain[];
  codes: TplCode[];
  defaultCols: TplDefaultCol[];
}

export const TEMPLATE_FILES = {
  bizAreas: 'biz_areas.csv',
  terms: 'terms.csv',
  domainClasses: 'domain_classes.csv',
  domains: 'domains.csv',
  codes: 'codes.csv',
  defaultCols: 'default_cols.csv',
} as const;

/** `src/project/builtin`(tsx·vitest)과 `dist/project/builtin`(빌드) 모두 세 단계 위가 `apps/server`다. */
export function templateDir(key: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../resources/templates', key.toLowerCase());
}

/** RFC 4180 CSV(따옴표·쉼표·줄바꿈 이스케이프). 첫 줄 머리글 → 객체 배열. */
export function parseCsv(text: string): Record<string, string>[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c !== '"') cell += c;
      else if (src[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  const [head, ...body] = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

function num(v: string | undefined): number | null {
  return v === undefined || v.trim() === '' ? null : Number(v);
}
const yes = (v: string | undefined): boolean => (v ?? '').trim().toUpperCase() === 'Y';

/** 템플릿 폴더의 CSV 6개를 읽는다. 파일이 없으면 오류. */
export function readTemplate(dir: string): TemplateData {
  const read = (file: string) => {
    const p = path.join(dir, file);
    if (!existsSync(p)) throw new Error(`템플릿 파일이 없습니다: ${p}`);
    return parseCsv(readFileSync(p, 'utf8'));
  };
  return {
    bizAreas: read(TEMPLATE_FILES.bizAreas).map((r) => ({
      bizCd: r['업무구분코드'] ?? '',
      bizNm: r['업무구분명'] ?? '',
      tablePrefix: r['테이블접두어'] ?? '',
      sortNo: Number(r['정렬']),
      description: r['설명'] ?? '',
    })),
    terms: read(TEMPLATE_FILES.terms).map((r) => ({
      termKor: r['한글용어'] ?? '',
      termPhysical: r['물리약어'] ?? '',
      description: r['설명'] ?? '',
      synonymRef: r['동의어참조'] ?? '',
    })),
    domainClasses: read(TEMPLATE_FILES.domainClasses).map((r) => ({
      suffix: r['접미어'] ?? '',
      clsNm: r['명칭'] ?? '',
      colType: r['타입'] ?? '',
      colLength: num(r['길이']),
      colScale: num(r['스케일']),
      description: r['설명'] ?? '',
    })),
    domains: read(TEMPLATE_FILES.domains).map((r) => ({
      parts: [1, 2, 3, 4, 5, 6, 7].map((i) => (r[`명칭${i}`] ?? '').trim()).filter((p) => p !== ''),
      logicalNm: r['논리명'] ?? '',
      physicalNm: r['물리명'] ?? '',
      suffix: r['접미어'] ?? '',
      typeText: r['타입'] ?? '',
    })),
    codes: read(TEMPLATE_FILES.codes).map((r) => ({
      bizCd: r['업무구분코드'] ?? '',
      codeCls: r['코드구분'] ?? '',
      codeClsNm: r['코드구분명'] ?? '',
      codeClsDesc: r['코드구분설명'] ?? '',
      code: r['코드'] ?? '',
      codeNm: r['코드명'] ?? '',
      sortOrder: Number(r['정렬순서']),
    })),
    defaultCols: read(TEMPLATE_FILES.defaultCols).map((r) => ({
      setNm: r['세트명'] ?? '',
      setDesc: r['세트설명'] ?? '',
      isDefault: yes(r['기본세트']),
      colSeq: Number(r['순번']),
      logicalNm: r['논리명'] ?? '',
      physicalNm: r['물리명'] ?? '',
      isPk: yes(r['PK']),
      dataType: r['타입'] ?? '',
      dataLength: num(r['길이']),
      dataScale: num(r['스케일']),
      isNullable: yes(r['NULL허용']),
      defaultVal: (r['기본값'] ?? '').trim() === '' ? null : r['기본값']!,
      colComment: r['코멘트'] ?? '',
    })),
  };
}
