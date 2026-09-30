import { describe, expect, it } from 'vitest';
import {
  codeCandidates,
  columnTermHint,
  runAutocomplete,
  suggestTableName,
} from '../../src/autocomplete/engine.js';
import { normalizeLogical } from '../../src/autocomplete/term-snapshot.js';
import { validateTable } from '../../src/ddl/validator.js';
import type { ColumnModel, TableModel } from '../../src/ddl/model.js';
import { makeSnapshot, type Dom } from './autocomplete-fixtures.js';

// T9.3 파이프라인(설계서 §5.3·§5.4·§5.6) — 4유형 + 코드 분기 + 경고. 실데이터는 test/db/autocomplete*.test.ts
const snap = makeSnapshot();
const codes = (r: { warnings: { code: string }[] }) => r.warnings.map((w) => w.code);

describe('정규화(§5.3)', () => {
  it('trim · 내부 공백 제거 · NFC · 라틴 대문자', () => {
    expect(normalizeLogical('  연구 과제\tid ')).toBe('연구과제ID');
    // 조합형(NFD) 한글 → 완성형(NFC)
    expect(normalizeLogical('가')).toBe('가');
  });
});

describe('① exact', () => {
  it('도메인 논리명 정확일치 → 도메인 값 적용(초록 표준), 공백·소문자 입력도 정규화 후 일치', () => {
    const r = runAutocomplete(snap, ' 연구과제 id');
    expect(r.type).toBe('exact');
    expect(r.normalized).toBe('연구과제ID');
    expect(r.applied).toEqual({
      physicalNm: 'RSCH_PRJ_ID',
      dataType: 'VARCHAR',
      dataLength: 20,
      dataScale: null,
      typeText: 'VARCHAR(20)',
      colComment: '연구과제ID',
      domainId: 1000,
      matchType: 'EXACT',
    });
    expect(r.warnings).toEqual([]);
  });

  it('검토 도메인: physical 있으면 exact + W_DOMAIN_REVIEW, physical NULL이면 exact로 보지 않고 다음 단계 + W_DOMAIN_REVIEW', () => {
    const a = runAutocomplete(snap, '예산금액');
    expect(a.type).toBe('exact');
    expect(codes(a)).toEqual(['W_DOMAIN_REVIEW']);
    const b = runAutocomplete(snap, '검토의견');
    expect(b.type).not.toBe('exact');
    expect(codes(b)).toContain('W_DOMAIN_REVIEW');
  });
});

describe('③ similar', () => {
  it('접수일자: 도메인 부분 일치 랭킹(≤5) + 마지막에 조합 1(RCPT_DT)', () => {
    const r = runAutocomplete(snap, '접수일자');
    expect(r.type).toBe('similar');
    expect(r.applied).toBeNull();
    const c = r.candidates!;
    expect(c[0]).toMatchObject({
      kind: 'domain',
      logicalNm: '과제접수일자',
      physicalNm: 'PRJ_RCPT_DT',
    });
    // 점수: contains 50 + 접미어 DT 일치 20 − 길이차 2 + 분류 5 = 73
    expect(c[0]!.score).toBe(73);
    expect(c.at(-1)).toMatchObject({
      kind: 'composed',
      physicalNm: 'RCPT_DT',
      typeText: 'VARCHAR(8)',
      segments: [
        { kor: '접수', physical: 'RCPT', matched: true },
        { kor: '일자', physical: 'DT', matched: true },
      ],
    });
    expect(c.filter((x) => x.kind === 'domain').length).toBeLessThanOrEqual(5);
  });

  it('startsWith 가산: 접수 → 접수구분·접수번호·접수일시가 과제접수일자보다 위', () => {
    const r = runAutocomplete(snap, '접수');
    expect(r.type).toBe('similar');
    const names = r.candidates!.filter((x) => x.kind === 'domain').map((x) => x.logicalNm);
    expect(names.slice(0, 3).sort()).toEqual(['접수구분', '접수번호', '접수일시']);
    expect(names.at(-1)).toBe('과제접수일자');
  });

  it('입력이 도메인 논리명을 포함(길이 ≥ 2): 연구과제명칭 ⊃ 연구과제명', () => {
    const r = runAutocomplete(snap, '연구과제명칭');
    expect(r.type).toBe('similar');
    expect(r.candidates![0]).toMatchObject({ logicalNm: '연구과제명', physicalNm: 'RSCH_PRJ_NM' });
  });
});

describe('④ composed', () => {
  it('similar 0 + 완전 분절 → 조각·물리명·접미어 타입 적용(COMPOSED, 도메인 없음)', () => {
    const r = runAutocomplete(snap, '연구과제번호');
    expect(r.type).toBe('composed');
    expect(r.applied).toMatchObject({
      physicalNm: 'RSCH_PRJ_NO',
      typeText: 'VARCHAR(20)',
      domainId: null,
      matchType: 'COMPOSED',
      colComment: '연구과제번호',
    });
    expect(r.segments!.map((s) => s.kor)).toEqual(['연구', '과제', '번호']);
    expect(r.warnings).toEqual([]);
  });

  it('대안 ≤ 2', () => {
    const s = makeSnapshot({
      terms: [
        ['가나다', 'X'],
        ['라', 'R'],
        ['마', 'M'],
        ['가나', 'A'],
        ['다라마', 'B'],
      ],
    });
    const r = runAutocomplete(s, '가나다라마');
    expect(r.type).toBe('composed');
    expect(r.applied!.physicalNm).toBe('A_B');
    expect(r.alternatives).toEqual([{ physicalNm: 'X_R_M', segments: expect.any(Array) }]);
  });

  it('접미어 미등록 → 타입 NULL + W_SUFFIX_UNREGISTERED', () => {
    const r = runAutocomplete(snap, '라벨칸정보');
    expect(r.type).toBe('composed');
    expect(r.applied).toMatchObject({
      physicalNm: 'LABEL_KAN_INFO',
      dataType: null,
      typeText: null,
    });
    expect(codes(r)).toEqual(['W_SUFFIX_UNREGISTERED']);
    expect(r.warnings[0]!.message).toContain('INFO');
  });

  it('검토대기(PENDING) 조각 → status PENDING + W_TERM_PENDING', () => {
    const r = runAutocomplete(snap, '검토번호');
    expect(r.type).toBe('composed');
    expect(r.segments![0]).toMatchObject({ kor: '검토', status: 'PENDING' });
    expect(codes(r)).toEqual(['W_TERM_PENDING']);
  });
});

describe('⑤ unregistered', () => {
  it('연구책임자구분(책임자 반려 = 미등록) → 부분 물리명 RSCH_?_TP, 접미어 TP 타입, W_TERM_UNREGISTERED', () => {
    const r = runAutocomplete(snap, '연구책임자구분');
    expect(r.type).toBe('unregistered');
    expect(r.applied).toMatchObject({
      physicalNm: 'RSCH_?_TP',
      typeText: 'VARCHAR(10)',
      matchType: 'UNREGISTERED',
    });
    expect(r.segments).toEqual([
      {
        kor: '연구',
        physical: 'RSCH',
        matched: true,
        termId: expect.any(Number),
        status: 'APPROVED',
      },
      { kor: '책임자', physical: null, matched: false },
      {
        kor: '구분',
        physical: 'TP',
        matched: true,
        termId: expect.any(Number),
        status: 'APPROVED',
      },
    ]);
    expect(codes(r)).toEqual(['W_TERM_UNREGISTERED']);
  });

  it('인라인 등록 후(책임자=RESP PENDING) 같은 입력 → composed RSCH_RESP_TP VARCHAR(10)(S4)', () => {
    const after = makeSnapshot({ terms: [['책임자', 'RESP', 'PENDING']] });
    // 기본 목록의 REJECTED 행보다 뒤에 넣었으므로 PENDING이 이긴다(같은 한글 = 같은 행을 갱신한 효과)
    const r = runAutocomplete(after, '연구책임자구분');
    expect(r.type).toBe('composed');
    expect(r.applied).toMatchObject({ physicalNm: 'RSCH_RESP_TP', typeText: 'VARCHAR(10)' });
    expect(codes(r)).toEqual(['W_TERM_PENDING']);
  });
});

describe('⑥ 코드성 후보(§5.6)', () => {
  it('연구과제상태코드: 정확 100(연구과제상태) > 끝 일치 60(과제상태·상태) > 포함 30, 상위 3, 같은 업무구분 +10', () => {
    const c = codeCandidates(snap, '연구과제상태코드', { bizAreaId: 1 });
    expect(c.map((x) => [x.codeClsNm, x.score])).toEqual([
      ['연구과제상태', 110],
      ['과제상태', 70],
      ['상태', 60],
    ]);
    expect(c[0]).toMatchObject({
      codeClsId: 13,
      bizCd: 'RP',
      codeCls: '041',
      logicalNm: '연구과제상태코드',
      physicalNm: 'RSCH_PRJ_STAT_CD',
      typeText: 'VARCHAR(10)',
      colComment: '연구과제상태코드(RP/041)',
      codeCnt: 4,
      domainId: null,
    });
    // 코드구분명 + '코드'가 도메인과 정확일치하면 도메인 값·domainId
    expect(c[1]).toMatchObject({ physicalNm: 'PRJ_STAT_CD', domainId: 1009 });
  });

  it('코드성 후보는 어떤 type에도 붙는다(…코드로 끝날 때만)', () => {
    const r = runAutocomplete(snap, '연구과제상태코드');
    expect(r.codeCandidates!.length).toBe(3);
    expect(runAutocomplete(snap, '연구과제번호').codeCandidates).toBeUndefined();
    expect(codeCandidates(snap, '코드')).toEqual([]);
  });
});

describe('응답 크기(§5.8 ≤ 5KB)', () => {
  it('유사 5 + 조합 1 + 코드 3에서도 5KB 이하', () => {
    const many = makeSnapshot({
      domains: Array.from({ length: 20 }, (_, i): Dom => [
        `연구과제상태코드${i}번째`,
        `RSCH_PRJ_STAT_CD${i}`,
        'CD',
        'VARCHAR',
        10,
      ]),
    });
    const r = runAutocomplete(many, '연구과제상태코드', { bizAreaId: 1 });
    expect(r.type).toBe('similar');
    const bytes = Buffer.byteLength(JSON.stringify({ ...r, cacheVersion: 1, elapsedMs: 1 }));
    expect(bytes).toBeLessThanOrEqual(5 * 1024);
  });
});

describe('테이블 물리명 제안(§5.5, T9.5)', () => {
  it('RP + 연구과제마스터 → RP_RSCH_PRJ_MST, PS → PS_RSCH_PRJ_MST, 접두어 없는 업무구분 → RSCH_PRJ_MST', () => {
    expect(suggestTableName(snap, '연구과제마스터', 1)).toMatchObject({
      tableNm: 'RP_RSCH_PRJ_MST',
      prefix: 'RP_',
      complete: true,
      warnings: [],
    });
    expect(suggestTableName(snap, '연구과제마스터', 2).tableNm).toBe('PS_RSCH_PRJ_MST');
    expect(suggestTableName(snap, '연구과제마스터', 3).tableNm).toBe('RSCH_PRJ_MST');
  });

  it('이미 접두어로 시작하면 중복 부여하지 않는다', () => {
    const s = makeSnapshot({ terms: [['연구과제', 'RP']] });
    expect(suggestTableName(s, '연구과제마스터', 1).tableNm).toBe('RP_MST');
  });

  it('미등록 조각 → ? + W_TERM_UNREGISTERED, complete false', () => {
    const r = suggestTableName(snap, '연구책임자마스터', 1);
    expect(r).toMatchObject({ tableNm: 'RP_RSCH_?_MST', complete: false });
    expect(r.warnings.map((w) => w.code)).toEqual(['W_TERM_UNREGISTERED']);
  });
});

describe('재검증 힌트(§4.8, T9.9) → TableValidator W_TERM_*', () => {
  const col = (over: Partial<ColumnModel>): ColumnModel => ({
    columnId: 1,
    colSeq: 1,
    logicalNm: '연구과제번호',
    physicalNm: 'RSCH_PRJ_NO',
    isPk: false,
    dataType: 'VARCHAR',
    dataLength: 20,
    dataScale: null,
    isNullable: true,
    defaultVal: null,
    colComment: 'x',
    domainId: null,
    codeClsId: null,
    defaultColId: null,
    matchType: 'COMPOSED',
    domain: null,
    codeClsRef: null,
    ...over,
  });
  const table = (columns: ColumnModel[]): TableModel => ({
    tableId: 1,
    tableNm: 'RP_X',
    logicalNm: 'x',
    description: null,
    bizAreaId: 1,
    bizCd: 'RP',
    bizNm: '연구과제',
    tablePrefix: 'RP_',
    status: 'DRAFT',
    version: 1,
    columns,
  });
  const warn = (s: ReturnType<typeof makeSnapshot>, columns: ColumnModel[]) =>
    validateTable(table(columns), {
      dialect: 'POSTGRESQL',
      termHints: (c) => columnTermHint(s, c),
    }).warnings.filter((w) => w.code.startsWith('W_TERM'));

  it('변화 없음 → 경고 없음. 용어 정정(번호 NO → NUM) → W_TERM_CHANGED RSCH_PRJ_NO → RSCH_PRJ_NUM', () => {
    expect(warn(snap, [col({})])).toEqual([]);
    const changed = makeSnapshot({ terms: [['번호', 'NUM']] });
    const w = warn(changed, [col({})]);
    expect(w.map((x) => x.code)).toEqual(['W_TERM_CHANGED']);
    expect(w[0]!.message).toBe('표준이 바뀌었습니다: RSCH_PRJ_NO → RSCH_PRJ_NUM');
  });

  it('검토대기 조각 W_TERM_PENDING, 반려 조각 W_TERM_REJECTED(+ 미등록 컬럼), EXACT·MANUAL·기본컬럼은 대상 아님', () => {
    const w = warn(snap, [
      col({ logicalNm: '검토번호', physicalNm: 'RVIEW_NO' }),
      col({ logicalNm: '연구책임자구분', physicalNm: 'RSCH_MGR_TP', matchType: 'UNREGISTERED' }),
      col({ logicalNm: '검토번호', physicalNm: 'X_NO', matchType: 'MANUAL' }),
      col({ logicalNm: '검토번호', physicalNm: 'Y_NO', matchType: 'EXACT' }),
      col({ logicalNm: '검토번호', physicalNm: 'Z_NO', defaultColId: 3 }),
    ]);
    expect(w.map((x) => [x.rowIndex, x.code])).toEqual([
      [0, 'W_TERM_PENDING'],
      [1, 'W_TERM_UNREGISTERED'],
      [1, 'W_TERM_REJECTED'],
    ]);
  });

  it('대안 분절을 골라 저장했으면 바뀐 것이 아니다', () => {
    const s = makeSnapshot({
      terms: [
        ['가나다', 'X'],
        ['라', 'R'],
        ['마', 'M'],
        ['가나', 'A'],
        ['다라마', 'B'],
      ],
    });
    expect(warn(s, [col({ logicalNm: '가나다라마', physicalNm: 'X_R_M' })])).toEqual([]);
  });

  it('미등록이던 컬럼의 용어가 등록되면 W_TERM_CHANGED(재적용 안내)', () => {
    const after = makeSnapshot({ terms: [['책임자', 'RESP', 'PENDING']] });
    const w = warn(after, [
      col({ logicalNm: '연구책임자구분', physicalNm: 'RSCH_MGR_TP', matchType: 'UNREGISTERED' }),
    ]);
    expect(w.map((x) => x.code)).toEqual([
      'W_TERM_UNREGISTERED',
      'W_TERM_PENDING',
      'W_TERM_CHANGED',
    ]);
  });
});
