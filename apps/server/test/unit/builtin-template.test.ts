import { describe, expect, it } from 'vitest';
import {
  parseCsv,
  readTemplate,
  templateDir,
  type TemplateData,
} from '../../src/project/builtin/template-files.js';
import { checkTemplate } from '../../src/project/builtin/template-quality.js';

/** 동봉 범용 기본 표준 STDV1(CR-16): 품질 검사 위반 0건이 "완벽한 셋"의 판정 기준(§2.1 Q1~Q8). */
describe('기본 표준 템플릿 STDV1(CR-16)', () => {
  const data = readTemplate(templateDir('STDV1'));

  it('품질 검사 Q1~Q8 위반 0건', () => {
    const violations = checkTemplate(data);
    expect(violations.map((x) => `${x.rule} ${x.target}: ${x.message}`)).toEqual([]);
  });

  it('구성 — 업무구분 10(CM·SY 포함, RP 없음), 항목마다 비어 있지 않음', () => {
    expect(data.bizAreas.map((b) => b.bizCd)).toEqual([
      'CM',
      'SY',
      'PS',
      'AC',
      'BD',
      'CT',
      'GW',
      'SL',
      'PU',
      'IV',
    ]);
    expect(data.terms.length).toBeGreaterThan(1000);
    expect(data.domainClasses.length).toBeGreaterThan(50);
    expect(data.domains.length).toBeGreaterThan(900);
    expect(new Set(data.codes.map((c) => `${c.bizCd}/${c.codeCls}`)).size).toBeGreaterThan(90);
    expect(new Set(data.defaultCols.map((c) => c.setNm))).toEqual(
      new Set(['표준 감사', '간단 감사']),
    );
  });

  it('업종·기관 고유 이름이 없다(패션·유통 승계 템플릿 RETAILV1에만 남는다)', () => {
    const names = [
      '세정',
      '올리비아',
      '트레몰로',
      '연심회',
      '연관위',
      '브랜드존',
      '아소트',
      '봉제',
    ];
    const blob = JSON.stringify(data);
    expect(names.filter((n) => blob.includes(n))).toEqual([]);
  });

  it('승계 데이터의 오류가 고쳐져 있다', () => {
    const term = (k: string) => data.terms.find((t) => t.termKor === k);
    expect(term('상태')?.termPhysical).toBe('STAT');
    expect(term('STATUS')).toBeUndefined();
    expect(term('제안자')?.termPhysical).not.toBe(term('속성')?.termPhysical);
    expect(term('주문')?.termPhysical).not.toBe(term('순서')?.termPhysical);
    expect(term('입사')?.termPhysical).not.toBe(term('가입')?.termPhysical);
    expect(data.domainClasses.find((c) => c.suffix === 'LSTYY')).toBeUndefined();
    const blood = data.codes.filter((c) => c.codeClsNm === '혈액형').map((c) => c.codeNm);
    expect(blood).toEqual(['A형', 'B형', 'O형', 'AB형']);
  });
});

describe('품질 검사기 — 위반을 잡는다', () => {
  const base: TemplateData = {
    bizAreas: [
      { bizCd: 'CM', bizNm: '공통', tablePrefix: 'CM_', sortNo: 1, description: '공통' },
      { bizCd: 'SY', bizNm: '시스템', tablePrefix: 'SY_', sortNo: 2, description: '시스템' },
    ],
    terms: [
      { termKor: '고객', termPhysical: 'CUST', description: 'Customer', synonymRef: '' },
      { termKor: '명', termPhysical: 'NM', description: 'Name', synonymRef: '명, 이름' },
      { termKor: '이름', termPhysical: 'NM', description: 'Name', synonymRef: '명, 이름' },
    ],
    domainClasses: [
      {
        suffix: 'NM',
        clsNm: '명, 이름',
        colType: 'VARCHAR',
        colLength: 100,
        colScale: null,
        description: '이름',
      },
    ],
    domains: [
      {
        parts: ['고객', '명'],
        logicalNm: '고객명',
        physicalNm: 'CUST_NM',
        suffix: 'NM',
        typeText: 'VARCHAR(100)',
      },
    ],
    codes: [
      {
        bizCd: 'CM',
        codeCls: '001',
        codeClsNm: '사용여부',
        codeClsDesc: '사용 여부',
        code: 'Y',
        codeNm: '사용',
        sortOrder: 1,
      },
    ],
    defaultCols: [
      {
        setNm: '기본',
        setDesc: '기본',
        isDefault: true,
        colSeq: 1,
        logicalNm: '고객명',
        physicalNm: 'CUST_NM',
        isPk: false,
        dataType: 'VARCHAR',
        dataLength: 100,
        dataScale: null,
        isNullable: true,
        defaultVal: null,
        colComment: '고객명',
      },
    ],
  };

  it('정상 데이터는 0건', () => {
    expect(checkTemplate(base)).toEqual([]);
  });

  it('동의어참조 누락·물리명 불일치·미등록 조각·코드 형식 혼재·도메인 없는 분류', () => {
    const bad: TemplateData = {
      ...base,
      terms: [
        ...base.terms.slice(0, 2),
        { termKor: '이름', termPhysical: 'NM', description: 'Name', synonymRef: '' },
      ],
      domainClasses: [
        ...base.domainClasses,
        {
          suffix: 'CUST',
          clsNm: '고객',
          colType: 'VARCHAR',
          colLength: 10,
          colScale: null,
          description: '고객',
        },
      ],
      domains: [
        { ...base.domains[0]!, physicalNm: 'CUSTOMER_NM' },
        {
          parts: ['회원', '명'],
          logicalNm: '회원명',
          physicalNm: 'MBR_NM',
          suffix: 'NM',
          typeText: 'VARCHAR(100)',
        },
      ],
      codes: [...base.codes, { ...base.codes[0]!, code: '001', codeNm: '미사용', sortOrder: 2 }],
    };
    const rules = checkTemplate(bad).map((x) => `${x.rule} ${x.target}`);
    expect(rules).toEqual(
      expect.arrayContaining(['Q3 이름', 'Q5 고객명', 'Q5 회원명', 'Q6 CM/001', 'Q8 CUST']),
    );
  });
});

describe('parseCsv', () => {
  it('BOM·따옴표·쉼표·줄바꿈', () => {
    expect(parseCsv('﻿a,b\n"x, y","say ""hi""\nok"\n')).toEqual([{ a: 'x, y', b: 'say "hi"\nok' }]);
  });
});
