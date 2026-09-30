import { describe, expect, it } from 'vitest';
import type { DefaultColItem, TableDetail } from '@termflow/shared';
import { alignColumns, diffCount } from '../editor/compare.js';
import { createEditorCore, parseTypeCell, stateOf } from './editor.js';

// T8.7 편집기 스토어: 행 상태 머신(idle·manual·invalid·default), dirty 추적, 서버 응답 병합
const DEF: DefaultColItem[] = ['FIRS_REG_DTS', 'FINA_REG_DTS'].map((nm, i) => ({
  defaultColId: 100 + i,
  colSeq: i + 1,
  logicalNm: nm,
  physicalNm: nm,
  isPk: false,
  dataType: 'TIMESTAMP',
  dataLength: 0,
  dataScale: null,
  typeText: 'TIMESTAMP(0)',
  isNullable: true,
  defaultVal: 'CURRENT_TIMESTAMP',
  colComment: nm,
}));
const detail = (): TableDetail => ({
  table: {
    tableId: 7,
    projectKey: 'RMS',
    bizAreaId: 6,
    bizCd: 'RP',
    bizNm: '연구과제',
    tablePrefix: 'RP_',
    bizUseYn: true,
    tableNm: 'RP_A_MST',
    tableLogicalNm: '가',
    description: null,
    status: 'DRAFT',
    version: 3,
    finalizedAt: null,
    finalizedBy: null,
    reviewYn: false,
    reviewNote: null,
    createdBy: 'editor',
    createdAt: '2026-09-29T10:00:00',
    updatedBy: 'editor',
    updatedByNm: '편집자',
    updatedAt: '2026-09-29T10:00:00',
  },
  columns: [
    {
      columnId: 1,
      colSeq: 1,
      logicalNm: '아이디',
      physicalNm: 'A_ID',
      isPk: true,
      dataType: 'VARCHAR',
      dataLength: 20,
      dataScale: null,
      isNullable: false,
      defaultVal: null,
      colComment: '아이디',
      domainId: 9,
      codeClsId: null,
      defaultColId: null,
      matchType: 'EXACT',
      domainNm: '아이디',
      codeCls: null,
    },
    {
      columnId: 2,
      colSeq: 2,
      logicalNm: '상태코드',
      physicalNm: 'STAT_CD',
      isPk: false,
      dataType: 'VARCHAR',
      dataLength: 10,
      dataScale: null,
      isNullable: true,
      defaultVal: null,
      colComment: null,
      domainId: null,
      codeClsId: 4,
      defaultColId: null,
      matchType: 'CODE',
      domainNm: null,
      codeCls: { codeClsId: 4, bizCd: 'RP', codeCls: '030', codeClsNm: '상태' },
    },
    {
      columnId: 3,
      colSeq: 3,
      logicalNm: 'FIRS_REG_DTS',
      physicalNm: 'FIRS_REG_DTS',
      isPk: false,
      dataType: 'TIMESTAMP',
      dataLength: 0,
      dataScale: null,
      isNullable: true,
      defaultVal: 'CURRENT_TIMESTAMP',
      colComment: 'FIRS_REG_DTS',
      domainId: null,
      codeClsId: null,
      defaultColId: 100,
      matchType: 'DEFAULT',
      domainNm: null,
      codeCls: null,
    },
  ],
  errors: [],
  warnings: [],
});

describe('행 상태 머신(§10.4)', () => {
  it('로드: match_type → 표시 상태(EXACT→exact, CODE→code, DEFAULT·defaultColId→default), 세트에 없는 기본컬럼은 제외 상태로 영역에', () => {
    const s = createEditorCore();
    s.load(detail(), DEF);
    expect(s.rows.value.map((r) => [r.physicalNm, r.state])).toEqual([
      ['A_ID', 'exact'],
      ['STAT_CD', 'code'],
    ]);
    expect(s.defaultRows.value.map((r) => [r.physicalNm, r.state, r.included])).toEqual([
      ['FIRS_REG_DTS', 'default', true],
      ['FINA_REG_DTS', 'default', false],
    ]);
    expect(s.dirty.value).toBe(false);
    expect(stateOf('MANUAL', null)).toBe('manual');
    expect(stateOf('SIMILAR', null)).toBe('exact');
  });

  it('idle → 논리명만 입력하면 idle 유지 → 물리명·타입 직접 입력하면 manual(match_type MANUAL)', () => {
    const s = createEditorCore();
    s.initNew('RMS', { bizAreaId: 6, prefix: 'RP_', defaultSet: DEF });
    const r = s.rows.value[0]!;
    expect(r.state).toBe('idle');
    s.setCell(r.uid, 'logicalNm', '연구과제명');
    expect(s.find(r.uid)!.state).toBe('idle');
    s.setCell(r.uid, 'physicalNm', 'rsch_prj_nm');
    expect(s.find(r.uid)!).toMatchObject({ state: 'manual', matchType: 'MANUAL' });
    // 표준(exact) 행도 물리명·타입을 고치면 manual, 논리명·코멘트는 상태 유지
    s.load(detail(), DEF);
    const ex = s.rows.value[0]!;
    s.setCell(ex.uid, 'colComment', '바꿈');
    expect(s.find(ex.uid)!.state).toBe('exact');
    s.setCell(ex.uid, 'typeText', 'VARCHAR(30)');
    expect(s.find(ex.uid)!).toMatchObject({
      state: 'manual',
      matchType: 'MANUAL',
      dataLength: 30,
      domainId: 9,
    });
  });

  it('default 행은 편집 불가·포함/제외만 → 제외하면 저장 본문에서 빠진다', () => {
    const s = createEditorCore();
    s.initNew('RMS', { bizAreaId: 6, prefix: 'RP_', defaultSet: DEF });
    expect(s.payload.value.columns.map((c) => c.physicalNm)).toEqual([
      'FIRS_REG_DTS',
      'FINA_REG_DTS',
    ]);
    const d = s.defaultRows.value[1]!;
    s.setCell(d.uid, 'physicalNm', 'X');
    expect(s.find(d.uid)!.physicalNm).toBe('FINA_REG_DTS');
    s.toggleDefault(d.uid);
    expect(s.payload.value.columns.map((c) => c.physicalNm)).toEqual(['FIRS_REG_DTS']);
    expect(s.payload.value.columns[0]).toMatchObject({ defaultColId: 100, matchType: 'DEFAULT' });
  });

  it('invalid(파생): 행에 E가 있으면 invalid, E가 사라지면 원래 상태 / 타입 셀 형식 오류는 로컬 E', () => {
    const s = createEditorCore();
    s.load(detail(), DEF);
    const r = s.rows.value[1]!;
    s.setServerIssues(
      [{ code: 'E_PHYS_DUP', target: 'column', rowIndex: 1, field: 'physicalNm', message: '중복' }],
      [{ code: 'W_PK_NONE', target: 'table', message: 'PK가 없습니다' }],
    );
    expect(s.displayState(s.find(r.uid)!)).toBe('invalid');
    expect(s.fieldError(r.uid, 'physicalNm')?.code).toBe('E_PHYS_DUP');
    expect(s.warnings.value.map((w) => [w.code, w.uid])).toEqual([['W_PK_NONE', null]]);
    s.clearServerIssues();
    expect(s.displayState(s.find(r.uid)!)).toBe('code');
    s.setCell(r.uid, 'typeText', 'VARCHR(20)');
    expect(s.errors.value.map((e) => [e.code, e.uid])).toEqual([['E_TYPE_FORMAT', r.uid]]);
    expect(s.displayState(s.find(r.uid)!)).toBe('invalid');
    s.setCell(r.uid, 'typeText', 'varchar(20)');
    expect(s.errors.value).toEqual([]);
    expect(s.find(r.uid)!).toMatchObject({ dataType: 'VARCHAR', dataLength: 20 });
  });

  it('PK 체크 시 NOT NULL 자동, PK면 NULL 허용으로 되돌릴 수 없음', () => {
    const s = createEditorCore();
    s.initNew('RMS', { bizAreaId: 6, prefix: 'RP_', defaultSet: [] });
    const r = s.rows.value[0]!;
    s.setCell(r.uid, 'isPk', true);
    expect(s.find(r.uid)!.isNullable).toBe(false);
    s.setCell(r.uid, 'isNullable', true);
    expect(s.find(r.uid)!.isNullable).toBe(false);
  });

  it('행 이동(Alt+↑↓·드래그)·추가·삭제, 빈 입력 대기 행은 본문에서 제외', () => {
    const s = createEditorCore();
    s.load(detail(), DEF);
    const [a, b] = s.rows.value;
    expect(s.moveRow(a!.uid, -1)).toBe(false);
    expect(s.moveRow(a!.uid, 1)).toBe(true);
    expect(s.rows.value.map((r) => r.physicalNm)).toEqual(['STAT_CD', 'A_ID']);
    s.moveRowTo(a!.uid, b!.uid);
    expect(s.rows.value.map((r) => r.physicalNm)).toEqual(['A_ID', 'STAT_CD']);
    const n = s.addRow();
    expect(s.payload.value.columns).toHaveLength(3); // 빈 행 제외(기본컬럼 1 포함)
    s.setCell(n.uid, 'logicalNm', '새');
    expect(s.payload.value.columns).toHaveLength(4);
    s.removeRow(n.uid);
    expect(s.rows.value).toHaveLength(2);
  });

  it('논리명 Enter(단계 8): 마지막 행이면 새 행, 아니면 다음 행 — 자동완성 훅(T9.7)이 있으면 먼저 호출', async () => {
    const s = createEditorCore();
    s.load(detail(), DEF);
    const [a, b] = s.rows.value;
    expect((await s.onLogicalEnter(a!.uid)).uid).toBe(b!.uid);
    const created = await s.onLogicalEnter(b!.uid);
    expect(s.rows.value).toHaveLength(3);
    expect(created.state).toBe('idle');
    const seen: string[] = [];
    s.autocomplete.value = async (row) => {
      seen.push(row.logicalNm);
    };
    await s.onLogicalEnter(a!.uid);
    expect(seen).toEqual(['아이디']);
  });
});

describe('dirty·서버 응답 병합', () => {
  it('편집 → dirty, 저장 응답의 새 columnId를 본문 순서대로 붙이고 version 갱신 → dirty 해제', () => {
    const s = createEditorCore();
    s.initNew('RMS', { bizAreaId: 6, prefix: 'RP_', defaultSet: DEF.slice(0, 1) });
    expect(s.dirty.value).toBe(false);
    const r = s.rows.value[0]!;
    s.setCell(r.uid, 'logicalNm', '아이디');
    s.setCell(r.uid, 'physicalNm', 'A_ID');
    s.setCell(r.uid, 'typeText', 'VARCHAR(20)');
    s.header.tableNm = 'RP_NEW';
    expect(s.dirty.value).toBe(true);
    const uids = s.payloadRows.value.map((x) => x.uid);
    const sent = s.payloadJson.value;
    s.applySaved(
      {
        tableId: 70,
        version: 1,
        status: 'DRAFT',
        columns: [
          { columnId: 501, colSeq: 1 },
          { columnId: 502, colSeq: 2 },
        ],
        changeSummary: '테이블 생성 · 컬럼 2',
        warnings: [{ code: 'W_PK_NONE', target: 'table', message: 'PK가 없습니다' }],
      },
      uids,
      sent,
    );
    expect(s.tableId.value).toBe(70);
    expect(s.version.value).toBe(1);
    expect(s.payload.value.columns.map((c) => c.columnId)).toEqual([501, 502]);
    expect(s.dirty.value).toBe(false);
    expect(s.warnings.value).toHaveLength(1);
  });

  it('저장 중에 계속 편집한 부분은 저장 후에도 dirty로 남는다', () => {
    const s = createEditorCore();
    s.load(detail(), DEF);
    const uids = s.payloadRows.value.map((x) => x.uid);
    const sent = s.payloadJson.value;
    s.setCell(s.rows.value[0]!.uid, 'colComment', '저장 중 편집');
    s.applySaved(
      {
        tableId: 7,
        version: 4,
        status: 'DRAFT',
        columns: [1, 2, 3].map((i) => ({ columnId: i, colSeq: i })),
        changeSummary: '',
        warnings: [],
      },
      uids,
      sent,
    );
    expect(s.version.value).toBe(4);
    expect(s.dirty.value).toBe(true);
  });

  it('업무구분 변경: 물리명이 이전 접두어로 시작하면 새 접두어로 교체(§5.5)', () => {
    const s = createEditorCore();
    s.load(detail(), DEF);
    s.changeBizArea(9, 'RP_', 'PS_');
    expect(s.header).toMatchObject({ bizAreaId: 9, tableNm: 'PS_A_MST' });
    s.header.tableNm = 'CUSTOM';
    s.changeBizArea(6, 'PS_', 'RP_');
    expect(s.header.tableNm).toBe('CUSTOM');
  });

  it('타입 셀 파싱(StdTypeParser 공유): 별칭·공백·길이 누락 허용(서버가 E_TYPE_LEN_MISSING)', () => {
    expect(parseTypeCell('integer')).toMatchObject({ dataType: 'INT', typeError: null });
    expect(parseTypeCell('NUMERIC(13, 2)')).toMatchObject({
      dataType: 'NUMERIC',
      dataLength: 13,
      dataScale: 2,
    });
    expect(parseTypeCell('VARCHAR')).toMatchObject({
      dataType: 'VARCHAR',
      dataLength: null,
      typeError: null,
    });
    expect(parseTypeCell('')).toMatchObject({ dataType: null, typeError: null });
    expect(parseTypeCell('FOO(1)').typeError).toMatch(/알 수 없는 타입/);
    expect(parseTypeCell('VARCHAR(')).toMatchObject({ dataType: null });
  });
});

describe('두 버전 비교(충돌 병합·이력)', () => {
  it('컬럼 ID → 물리명으로 짝, 동일·변경·한쪽에만', () => {
    const base = detail().columns;
    const mine = [
      { ...base[0]!, dataLength: 30 },
      { ...base[1]!, columnId: null },
      { ...base[2]!, columnId: null, physicalNm: 'MY_ONLY' },
    ];
    const rows = alignColumns(base, mine);
    expect(
      rows.map((r) => [r.kind, r.left?.physicalNm ?? null, r.right?.physicalNm ?? null]),
    ).toEqual([
      ['chg', 'A_ID', 'A_ID'],
      ['same', 'STAT_CD', 'STAT_CD'],
      ['left', 'FIRS_REG_DTS', null],
      ['right', null, 'MY_ONLY'],
    ]);
    expect(rows[0]!.changes).toEqual(['타입']);
    expect(diffCount(rows)).toBe(3);
  });
});
