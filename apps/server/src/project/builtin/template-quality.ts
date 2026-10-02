import { STD_TYPES, STD_TYPES_LENGTH_REQUIRED, typeText, type StdType } from '@termflow/shared';
import {
  calculateDomain,
  type DomainClsEntry,
  type L1Snapshot,
  type TermEntry,
} from '../../autocomplete/domain-calculator.js';
import type { TemplateData } from './template-files.js';

/**
 * 기본 표준 템플릿 품질 검사기(CR-16 §2.1 Q1~Q8). 순수 함수 — 동봉 CSV를 단위 테스트에서, 적재 직전에 서버에서 같은 규칙으로 본다.
 * 위반 0건이 "완벽한 셋"의 판정 기준이다.
 */

export type QualityRule = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5' | 'Q6' | 'Q7' | 'Q8';

export interface QualityViolation {
  rule: QualityRule;
  target: string;
  message: string;
}

/** 한글 용어에 영문을 쓸 수 있는 약어(Q3). */
export const LATIN_TERM_ALLOW: ReadonlySet<string> = new Set([
  'AS',
  'CS',
  'EDI',
  'ERP',
  'ID',
  'IP',
  'JSON',
  'LOT',
  'MMS',
  'PC',
  'QR',
  'SMS',
  'URL',
  'VOC',
  'API',
  'OTP',
  'FAQ',
]);

/** 1글자 용어 허용 목록(Q3) — 조합에 꼭 필요하고 뜻이 하나로 읽히는 것만. */
export const ONE_CHAR_TERM_ALLOW: ReadonlySet<string> = new Set(
  '가 값 년 대 량 률 명 분 비 소 수 시 월 율 일 중 초 총 키 팀 폭 후 앱 웹'.split(' '),
);

/** 승계 데이터에서 찾은 오타(Q3) — 다시 들어오지 않게 막는다. */
export const KNOWN_TYPOS: readonly string[] = [
  'STAUS',
  'Visaul',
  'Verual',
  'Preson',
  'Volumn',
  'Totally',
  'Warming',
  'Calander',
  'Wharehouse',
  'Ooutsourcing',
  'Oraganization',
  'Statment',
  'Reciever',
  'Trasfer',
  'Preferntial',
];

/** 내부 문서 코드(Q1): 설계서 절, CR 번호, 승계 규칙 번호. */
const INTERNAL_CODE = /§\d|CR-\d{2}|\bR\d{2}\b|\bD1\d\b/;

const DOMAIN_PHYSICAL_MAX = 30;

function dupes<T>(list: readonly T[], key: (x: T) => string): string[] {
  const seen = new Map<string, number>();
  for (const x of list) seen.set(key(x), (seen.get(key(x)) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([k]) => k);
}

function badSpacing(s: string): boolean {
  return s !== s.trim() || /\s{2,}/.test(s);
}

export function checkTemplate(t: TemplateData): QualityViolation[] {
  const out: QualityViolation[] = [];
  const v = (rule: QualityRule, target: string, message: string) =>
    out.push({ rule, target, message });

  // ---------- Q1 공통 ----------
  const texts: [string, string][] = [
    ...t.bizAreas.flatMap((b): [string, string][] => [
      [`업무구분 ${b.bizCd}`, b.bizNm],
      [`업무구분 ${b.bizCd}`, b.description],
    ]),
    ...t.terms.flatMap((x): [string, string][] => [
      [`용어 ${x.termKor}`, x.termKor],
      [`용어 ${x.termKor}`, x.description],
    ]),
    ...t.domainClasses.map((c): [string, string] => [`도메인분류 ${c.suffix}`, c.description]),
    ...t.codes.flatMap((c): [string, string][] => [
      [`코드 ${c.bizCd}/${c.codeCls}`, c.codeClsNm],
      [`코드 ${c.bizCd}/${c.codeCls}`, c.codeClsDesc],
      [`코드 ${c.bizCd}/${c.codeCls}/${c.code}`, c.codeNm],
    ]),
    ...t.defaultCols.flatMap((c): [string, string][] => [
      [`기본컬럼 ${c.setNm}`, c.setDesc],
      [`기본컬럼 ${c.setNm}/${c.physicalNm}`, c.logicalNm],
    ]),
  ];
  for (const [target, s] of texts) {
    if (s.trim() === '') v('Q1', target, '필수 값·설명이 비어 있습니다');
    else if (badSpacing(s)) v('Q1', target, `앞뒤 공백·이중 공백: "${s}"`);
    if (INTERNAL_CODE.test(s)) v('Q1', target, `내부 문서 코드: "${s}"`);
  }

  // ---------- Q2 업무구분 ----------
  for (const b of t.bizAreas) {
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(b.bizCd)) v('Q2', b.bizCd, '업무구분코드 형식');
    if (b.tablePrefix !== `${b.bizCd}_`) v('Q2', b.bizCd, `테이블접두어 ${b.tablePrefix} ≠ 코드_`);
  }
  for (const d of dupes(t.bizAreas, (b) => b.bizCd)) v('Q2', d, '업무구분코드 중복');
  for (const must of ['CM', 'SY'])
    if (!t.bizAreas.some((b) => b.bizCd === must)) v('Q2', must, '공통·시스템 업무구분 없음');
  t.bizAreas
    .map((b) => b.sortNo)
    .sort((a, b) => a - b)
    .forEach((n, i) => {
      if (n !== i + 1) v('Q2', String(n), '정렬이 1부터 연속이 아닙니다');
    });

  // ---------- Q3 용어 ----------
  const termByKor = new Map(t.terms.map((x) => [x.termKor, x]));
  const byPhysical = new Map<string, string[]>();
  for (const x of t.terms) {
    const list = byPhysical.get(x.termPhysical) ?? [];
    list.push(x.termKor);
    byPhysical.set(x.termPhysical, list);
  }
  for (const d of dupes(t.terms, (x) => x.termKor)) v('Q3', d, '한글용어 중복');
  for (const x of t.terms) {
    if (!/^[A-Z][A-Z0-9]*$/.test(x.termPhysical) || x.termPhysical.length > 30)
      v('Q3', x.termKor, `물리약어 형식(조각 1개, '_' 없음): ${x.termPhysical}`);
    if (/[A-Za-z]/.test(x.termKor) && !LATIN_TERM_ALLOW.has(x.termKor))
      v('Q3', x.termKor, '영문 한글용어(허용 목록 밖)');
    if (/[0-9]/.test(x.termKor)) v('Q3', x.termKor, '숫자가 든 한글용어');
    if (x.termKor.length === 1 && !ONE_CHAR_TERM_ALLOW.has(x.termKor))
      v('Q3', x.termKor, '1글자 용어(허용 목록 밖)');
    for (const typo of KNOWN_TYPOS)
      if (`${x.termPhysical} ${x.description}`.includes(typo)) v('Q3', x.termKor, `오타: ${typo}`);
    const group = byPhysical.get(x.termPhysical) ?? [];
    const refs = x.synonymRef
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (group.length > 1) {
      const want = [...group].sort().join('|');
      const got = [...new Set(refs)].sort().join('|');
      if (want !== got)
        v('Q3', x.termKor, `같은 물리약어 ${x.termPhysical} 용어끼리 동의어참조가 맞지 않습니다`);
    } else if (refs.length > 0) {
      v('Q3', x.termKor, '같은 물리약어 용어가 없는데 동의어참조가 있습니다');
    }
  }

  // ---------- Q4 도메인분류 ----------
  for (const d of dupes(t.domainClasses, (c) => c.suffix)) v('Q4', d, '접미어 중복');
  for (const c of t.domainClasses) {
    if (!/^[A-Z0-9_]+$/.test(c.suffix)) v('Q4', c.suffix, '접미어 형식');
    const group = byPhysical.get(c.suffix);
    if (!group) v('Q4', c.suffix, '접미어를 물리약어로 쓰는 용어가 없습니다');
    const names = c.clsNm
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (names.length === 0) v('Q4', c.suffix, '명칭이 비어 있습니다');
    for (const n of names)
      if (termByKor.get(n)?.termPhysical !== c.suffix)
        v('Q4', c.suffix, `명칭 '${n}'이 접미어 ${c.suffix}의 용어가 아닙니다`);
    if (!(STD_TYPES as readonly string[]).includes(c.colType))
      v('Q4', c.suffix, `타입 ${c.colType}`);
    if (
      (STD_TYPES_LENGTH_REQUIRED as readonly string[]).includes(c.colType) &&
      c.colLength === null
    )
      v('Q4', c.suffix, `${c.colType}는 길이가 필요합니다`);
  }

  // ---------- Q5 도메인 ----------
  const snap: L1Snapshot = {
    termByKor: new Map<string, TermEntry>(
      t.terms.map((x) => [x.termKor, { physical: x.termPhysical }]),
    ),
    clsBySuffix: new Map<string, DomainClsEntry>(
      t.domainClasses.map((c) => [
        c.suffix,
        {
          domainClsId: null,
          colType: c.colType as StdType,
          colLength: c.colLength,
          colScale: c.colScale,
        },
      ]),
    ),
  };
  for (const d of dupes(t.domains, (x) => x.logicalNm)) v('Q5', d, '논리명 중복');
  for (const d of dupes(t.domains, (x) => x.physicalNm)) v('Q5', d, '물리명 중복');
  const usedSuffix = new Set<string>();
  for (const d of t.domains) {
    if (d.parts.length === 0 || d.parts.length > 7) v('Q5', d.logicalNm, '명칭 조각 수 1~7');
    if (d.parts.some((p) => /[0-9]/.test(p))) v('Q5', d.logicalNm, '숫자가 든 조각');
    const r = calculateDomain({ parts: d.parts }, snap);
    if (r.notFound.length > 0) v('Q5', d.logicalNm, `미등록 조각: ${r.notFound.join(', ')}`);
    if (r.colType === null) v('Q5', d.logicalNm, `접미어 ${r.suffix ?? '-'} 도메인분류 없음`);
    if (r.logicalNm !== d.logicalNm) v('Q5', d.logicalNm, `논리명 ≠ 조각 합(${r.logicalNm})`);
    if (r.physicalNm !== d.physicalNm)
      v('Q5', d.logicalNm, `물리명 ${d.physicalNm} ≠ 계산 ${r.physicalNm}`);
    if (r.suffix !== d.suffix) v('Q5', d.logicalNm, `접미어 ${d.suffix} ≠ 계산 ${r.suffix}`);
    if (r.typeText !== d.typeText)
      v('Q5', d.logicalNm, `타입 ${d.typeText} ≠ 계산 ${r.typeText ?? '-'}`);
    if (d.physicalNm.length > DOMAIN_PHYSICAL_MAX)
      v('Q5', d.logicalNm, `물리명 ${DOMAIN_PHYSICAL_MAX}자 초과`);
    if (r.suffix) usedSuffix.add(r.suffix);
  }

  // ---------- Q6 코드 ----------
  const bizCds = new Set(t.bizAreas.map((b) => b.bizCd));
  const classes = new Map<string, typeof t.codes>();
  for (const c of t.codes) {
    const k = `${c.bizCd}/${c.codeCls}`;
    classes.set(k, [...(classes.get(k) ?? []), c]);
  }
  const clsNames: { key: string; nm: string }[] = [];
  for (const [k, rows] of classes) {
    const first = rows[0]!;
    if (!bizCds.has(first.bizCd)) v('Q6', k, '없는 업무구분');
    if (!/^\d{3}$/.test(first.codeCls)) v('Q6', k, '코드구분은 숫자 3자리');
    if (rows.some((r) => r.codeClsNm !== first.codeClsNm || r.codeClsDesc !== first.codeClsDesc))
      v('Q6', k, '같은 코드구분에 이름·설명이 여러 개');
    clsNames.push({ key: k, nm: first.codeClsNm });
    for (const d of dupes(rows, (r) => r.code)) v('Q6', `${k}/${d}`, '코드 중복');
    for (const d of dupes(rows, (r) => r.codeNm)) v('Q6', `${k}/${d}`, '코드명 중복');
    const shape = (s: string) =>
      `${s.length}:${/^\d+$/.test(s) ? 'N' : /^[A-Za-z]+$/.test(s) ? 'A' : 'X'}`;
    if (new Set(rows.map((r) => shape(r.code))).size > 1)
      v('Q6', k, '코드 형식(길이·문자 종류)이 섞여 있습니다');
    if (rows.some((r) => shape(r.code).endsWith('X'))) v('Q6', k, '코드는 숫자만 또는 영문만');
    if (rows.some((r) => r.code.length > 10 || r.codeNm.length > 100))
      v('Q6', k, '코드·코드명 길이');
    rows
      .map((r) => r.sortOrder)
      .sort((a, b) => a - b)
      .forEach((n, i) => {
        if (n !== i + 1) v('Q6', k, '정렬순서가 1부터 연속이 아닙니다');
      });
  }
  for (const d of dupes(clsNames, (c) => c.nm))
    v('Q6', d, '코드구분명 중복(업무구분이 달라도 한 곳에만)');

  // ---------- Q7 기본컬럼 ----------
  const sets = new Map<string, typeof t.defaultCols>();
  for (const c of t.defaultCols) sets.set(c.setNm, [...(sets.get(c.setNm) ?? []), c]);
  const defaults = [...sets.values()].filter((rows) => rows[0]!.isDefault);
  if (defaults.length !== 1) v('Q7', '기본컬럼', `기본 세트가 ${defaults.length}개`);
  const domainByLogical = new Map(t.domains.map((d) => [d.logicalNm, d]));
  for (const [nm, rows] of sets) {
    if (rows.some((r) => r.isDefault !== rows[0]!.isDefault || r.setDesc !== rows[0]!.setDesc))
      v('Q7', nm, '같은 세트에 기본 여부·설명이 여러 개');
    for (const d of dupes(rows, (r) => r.physicalNm)) v('Q7', `${nm}/${d}`, '물리명 중복');
    rows
      .map((r) => r.colSeq)
      .sort((a, b) => a - b)
      .forEach((n, i) => {
        if (n !== i + 1) v('Q7', nm, '순번이 1부터 연속이 아닙니다');
      });
    for (const r of rows) {
      const d = domainByLogical.get(r.logicalNm);
      const colType = typeText(r.dataType, r.dataLength, r.dataScale);
      if (!d) v('Q7', `${nm}/${r.physicalNm}`, `같은 논리명 도메인 없음: ${r.logicalNm}`);
      else if (d.physicalNm !== r.physicalNm || d.typeText !== colType)
        v('Q7', `${nm}/${r.physicalNm}`, `도메인(${d.physicalNm} ${d.typeText})과 다름`);
    }
  }

  // ---------- Q8 교차 ----------
  for (const c of t.domainClasses)
    if (!usedSuffix.has(c.suffix)) v('Q8', c.suffix, '이 접미어를 쓰는 도메인이 없습니다');

  return out;
}
