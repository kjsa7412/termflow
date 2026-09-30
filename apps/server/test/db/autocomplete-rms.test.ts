import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ApprovalPage,
  AutocompleteBatchResponse,
  AutocompleteResponse,
  ColumnInput,
  DdlResponse,
  DefaultColSetItem,
  TableDetail,
  TableNameSuggestion,
  TableSaveResponse,
  TermInlineResponse,
} from '@termflow/shared';
import { runAutocomplete } from '../../src/autocomplete/engine.js';
import { joinPhysical, segmentFull, segmentPartial } from '../../src/autocomplete/segmenter.js';
import {
  loadTermSnapshot,
  normalizeLogical,
  type TermSnapshot,
} from '../../src/autocomplete/term-snapshot.js';
import { createDb, type Db } from '../../src/db/client.js';
import { Client, createTestApp, setTestEnv } from './setup/app.js';
import { createMigratedDatabase, FIXTURE_PASSWORD } from './setup/databases.js';
import { insertUsers, PHASE1, PHASE2, runSteps, tempReportRoot } from './setup/stdv1.js';

/**
 * 단계 9 실데이터(승계 RMS: 용어 1,705·도메인 4,587·코드구분 159·33 테이블 649 컬럼). `pnpm test:db -- autocomplete-rms`
 *  - T9.2: 승계 649 논리명 분절·자동완성 결과 분포 + EXACT가 아닌 행의 분절 스냅샷(`__snapshots__/rms-segments.txt`)
 *  - S2(10컬럼: exact 8·similar 1·composed 1 → 저장 → DDL) · S4(연구책임자구분 → 인라인 등록 → RSCH_RESP_TP VARCHAR(10))
 *    · S6(연구과제상태코드 → 코드구분 후보 → code_cls_id 저장) · 승인 큐 PENDING · 테이블 물리명 제안(실데이터)
 */
let pool: pg.Pool;
let db: Db;
let app: INestApplication;
let snap: TermSnapshot;
let rmsId = 0;
let rpId = 0;
const P = '/api/v1/projects/RMS';
const rep = tempReportRoot('tf-ac-rms-');

beforeAll(async () => {
  const url = await createMigratedDatabase('t_ac_rms');
  pool = new pg.Pool({ connectionString: url, max: 4 });
  db = createDb(pool);
  const users = await insertUsers(pool);
  expect((await runSteps({ pool, db, url }, rep.dir, 'p1', PHASE1)).ok).toBe(true);
  expect((await runSteps({ pool, db, url }, rep.dir, 'p2', PHASE2)).ok).toBe(true);
  rmsId = (await pool.query("select project_id id from tf_project where project_key = 'RMS'"))
    .rows[0].id as number;
  rpId = (
    await pool.query(
      "select biz_area_id id from prj_biz_area where project_id = $1 and biz_cd = 'RP'",
      [rmsId],
    )
  ).rows[0].id as number;
  for (const [login, role] of [
    ['pa', 'ADMIN'],
    ['editor', 'EDITOR'],
  ] as const) {
    await pool.query(
      `insert into tf_project_member (project_id, user_id, member_role, created_by, updated_by)
       values ($1, $2, $3, 'SYSTEM', 'SYSTEM')`,
      [rmsId, users[login], role],
    );
  }
  snap = await loadTermSnapshot(db, rmsId);
  setTestEnv(url);
  app = await createTestApp();
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  rep.cleanup();
});

async function as(login: string): Promise<Client> {
  const c = new Client(app.getHttpServer());
  expect((await c.login(login, FIXTURE_PASSWORD)).status).toBe(200);
  return c;
}
const ac = async (c: Client, logicalNm: string) => {
  const r = await c.post(`${P}/autocomplete/columns`, { logicalNm, bizAreaId: rpId });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as AutocompleteResponse;
};

describe('T9.2·T9.3 승계 649 논리명(실데이터)', () => {
  it('자동완성 분포: exact 271 · composed 378 · similar 0 · unregistered 0, exact 물리명 = 승계값 271/271, composed 303/378', async () => {
    const { rows } = await pool.query<{
      logical_nm: string;
      physical_nm: string;
      match_type: string;
    }>(
      'select logical_nm, physical_nm, match_type from prj_column where project_id = $1 order by table_id, col_seq',
      [rmsId],
    );
    expect(rows).toHaveLength(649);
    const dist: Record<string, number> = { exact: 0, similar: 0, composed: 0, unregistered: 0 };
    let exactSame = 0;
    let composedSame = 0;
    for (const r of rows) {
      const a = runAutocomplete(snap, r.logical_nm);
      dist[a.type]!++;
      if (a.type === 'exact' && a.applied!.physicalNm === r.physical_nm) exactSame++;
      if (a.type === 'composed' && a.applied!.physicalNm === r.physical_nm) composedSame++;
    }
    process.stderr.write(
      `[autocomplete-rms] 649 분포 ${JSON.stringify(dist)} · 승계 물리명 재현 exact ${exactSame}/${dist['exact']} composed ${composedSame}/${dist['composed']}\n`,
    );
    expect(dist).toEqual({ exact: 271, similar: 0, composed: 378, unregistered: 0 });
    expect(exactSame).toBe(271);
    // 불일치 75 = 최초/최종등록자ID(RGSRT ↔ 기본컬럼 REG_USER, 66) + 비고N내용(숫자 붙임 L1 규칙 RMK1 ↔ RMK_1, 9)
    expect(composedSame).toBe(303);
  });

  it('EXACT가 아닌 행(승계 match_type ≠ EXACT)의 분절 결과 스냅샷(고유 논리명)', async () => {
    const { rows } = await pool.query<{ logical_nm: string; physical_nm: string; mt: string }>(
      `select distinct logical_nm, physical_nm, match_type mt from prj_column
        where project_id = $1 and match_type <> 'EXACT'`,
      [rmsId],
    );
    // DB 콜레이션과 무관한 순서(코드 단위)로 고정
    const key = (r: { logical_nm: string; physical_nm: string }) =>
      `${r.logical_nm}\t${r.physical_nm}`;
    rows.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    const lines = rows.map((r) => {
      const s = normalizeLogical(r.logical_nm);
      const full = segmentFull(s, snap);
      const segs = full[0] ?? segmentPartial(s, snap).segs;
      const pieces = segs.map((x) => (x.kind === 'miss' ? `✗${x.kor}` : x.kor)).join('|');
      const a = runAutocomplete(snap, r.logical_nm);
      const mark = joinPhysical(segs) === r.physical_nm ? '=' : '≠';
      return `${r.logical_nm}\t${pieces}\t${joinPhysical(segs)}\t${mark} ${r.physical_nm}\t${a.type}\t${a.applied?.typeText ?? '-'}\t후보 ${full.length}`;
    });
    expect(lines.length).toBeGreaterThan(100);
    await expect(`${lines.join('\n')}\n`).toMatchFileSnapshot('./__snapshots__/rms-segments.txt');
  });
});

describe('S2 — 10컬럼(exact 8·similar 1·composed 1) → 저장 → DDL(실데이터 API)', () => {
  it('자동완성 10회 + 물리명 제안 → 저장 201 → DDL 19컬럼(기본컬럼 9 포함)', async () => {
    const e = await as('editor');
    const exactNames = [
      '전자결재번호',
      '요청일자',
      '심의일자',
      '사용여부',
      '삭제여부',
      '정렬순서',
      '첨부파일ID',
      '비용금액',
    ];
    const cols: ColumnInput[] = [];
    const types: string[] = [];
    for (const nm of exactNames) {
      const r = await ac(e, nm);
      types.push(r.type);
      cols.push({
        columnId: null,
        logicalNm: r.normalized,
        physicalNm: r.applied!.physicalNm,
        isPk: cols.length === 0,
        dataType: r.applied!.dataType,
        dataLength: r.applied!.dataLength,
        dataScale: r.applied!.dataScale,
        isNullable: cols.length !== 0,
        defaultVal: null,
        colComment: r.applied!.colComment,
        domainId: r.applied!.domainId,
        codeClsId: null,
        defaultColId: null,
        matchType: 'EXACT',
      });
    }
    // similar: 접수일 → 도메인 후보(접수일자·접수일시 …) 중 접수일자 선택(↓ Enter — 클릭 0)
    const sim = await ac(e, '접수일');
    types.push(sim.type);
    const pick = sim.candidates!.find((c) => c.logicalNm === '접수일자')!;
    expect(pick).toMatchObject({ kind: 'domain', physicalNm: 'RCPT_DT', typeText: 'VARCHAR(8)' });
    cols.push({
      columnId: null,
      logicalNm: pick.logicalNm,
      physicalNm: pick.physicalNm,
      isPk: false,
      dataType: pick.dataType,
      dataLength: pick.dataLength,
      dataScale: pick.dataScale,
      isNullable: true,
      defaultVal: null,
      colComment: pick.colComment,
      domainId: pick.domainId!,
      codeClsId: null,
      defaultColId: null,
      matchType: 'SIMILAR',
    });
    // composed: 과제관리번호 → PRJ_MNGT_NO(조각 배지, 다음 행 이동으로 암묵 확인)
    const comp = await ac(e, '과제관리번호');
    types.push(comp.type);
    expect(comp.applied).toMatchObject({ physicalNm: 'PRJ_MNGT_NO', matchType: 'COMPOSED' });
    cols.push({
      columnId: null,
      logicalNm: comp.normalized,
      physicalNm: comp.applied!.physicalNm,
      isPk: false,
      dataType: comp.applied!.dataType,
      dataLength: comp.applied!.dataLength,
      dataScale: comp.applied!.dataScale,
      isNullable: true,
      defaultVal: null,
      colComment: comp.applied!.colComment,
      domainId: null,
      codeClsId: null,
      defaultColId: null,
      matchType: 'COMPOSED',
    });
    expect(types).toEqual([...Array(8).fill('exact'), 'similar', 'composed']);

    const name = (
      await e.post(`${P}/tables/suggest-name`, { logicalNm: '과제접수이력', bizAreaId: rpId })
    ).body as TableNameSuggestion;
    expect(name).toMatchObject({ tableNm: 'RP_PRJ_RCPT_HST', complete: true, errors: [] });
    const sets = (await e.get(`${P}/standards/default-column-sets`)).body as DefaultColSetItem[];
    const dflt = sets
      .find((s) => s.isDefault)!
      .columns.map((d): ColumnInput => ({
        columnId: null,
        logicalNm: d.logicalNm,
        physicalNm: d.physicalNm,
        isPk: d.isPk,
        dataType: d.dataType,
        dataLength: d.dataLength,
        dataScale: d.dataScale,
        isNullable: d.isNullable,
        defaultVal: d.defaultVal,
        colComment: d.colComment ?? d.logicalNm,
        domainId: null,
        codeClsId: null,
        defaultColId: d.defaultColId,
        matchType: 'DEFAULT',
      }));
    const saved = await e.post(`${P}/tables`, {
      table: {
        bizAreaId: rpId,
        tableNm: name.tableNm,
        tableLogicalNm: '과제접수이력',
        description: null,
      },
      columns: [...cols, ...dflt],
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    const id = (saved.body as TableSaveResponse).tableId;
    const ddl = (await e.post(`${P}/ddl`, { tableIds: [id] })).body as DdlResponse;
    expect(ddl.tables[0]!.colCnt).toBe(19);
    expect(ddl.tables[0]!.sql).toContain('CREATE TABLE RP_PRJ_RCPT_HST');
    for (const c of cols) expect(ddl.tables[0]!.sql).toContain(c.physicalNm);
    await pool.query('delete from prj_table where table_id = $1', [id]);
  });
});

describe('S4 — 연구책임자구분(책임자 미등록) → 인라인 등록 → 자동 재시도(실데이터 API)', () => {
  it('책임자를 지운 상태에서 unregistered RSCH_RSPN_?_TP(등록 후보 책임자) → 등록 RESP → composed RSCH_RESP_TP VARCHAR(10), 승인 큐 PENDING', async () => {
    // 실데이터는 책임자 = MGR(승인)이다. 설계서 S4 전제(책임자만 미등록)를 만들려고 이 테스트 DB에서만 지운다
    await pool.query("delete from std_term where project_id = $1 and term_kor = '책임자'", [rmsId]);
    const sa = await as('sysadmin');
    expect((await sa.post('/api/v1/admin/cache/RMS/reload')).status).toBe(200);
    const e = await as('editor');
    const a0 = await ac(e, '연구책임자구분');
    expect(a0).toMatchObject({
      type: 'unregistered',
      applied: { physicalNm: 'RSCH_RSPN_?_TP', typeText: 'VARCHAR(10)', matchType: 'UNREGISTERED' },
      registerCandidates: ['책임자', '자'],
    });
    expect(a0.segments!.map((s) => [s.kor, s.matched])).toEqual([
      ['연구', true],
      ['책임', true],
      ['자', false],
      ['구분', true],
    ]);
    const reg = await e.post(`${P}/standards/terms/inline`, {
      termKor: a0.registerCandidates![0],
      termPhysical: 'RESP',
    });
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);
    const t0 = performance.now();
    const a1 = await ac(e, '연구책임자구분');
    const retryMs = performance.now() - t0;
    expect(a1).toMatchObject({
      type: 'composed',
      applied: { physicalNm: 'RSCH_RESP_TP', typeText: 'VARCHAR(10)', matchType: 'COMPOSED' },
    });
    expect(a1.segments!.find((s) => s.kor === '책임자')).toMatchObject({ status: 'PENDING' });
    process.stderr.write(
      `[autocomplete-rms] S4 등록 직후 재시도 ${retryMs.toFixed(0)}ms(캐시 재적재 포함, 서버 ${a1.elapsedMs}ms)\n`,
    );
    const pa = await as('pa');
    const q = (await pa.get(`${P}/standards/approvals`)).body as ApprovalPage;
    expect(q.items.map((x) => [x.termKor, x.termPhysical, x.status])).toContainEqual([
      '책임자',
      'RESP',
      'PENDING',
    ]);
    // 목업의 "RESP는 '응답'과 공유"는 실데이터에 없다(RESP 사용 용어 없음)
    expect((reg.body as TermInlineResponse).conflicts).toEqual([]);
  });
});

describe('S6 — 연구과제상태코드 → 코드구분 후보 선택 → code_cls_id 저장(실데이터 API)', () => {
  it('코드성 후보(끝 일치 PS/023 상태) 선택 → 저장 → prj_column.code_cls_id·match_type CODE, 물리명 RSCH_PRJ_STAT_CD', async () => {
    const e = await as('editor');
    const r = await ac(e, '연구과제상태코드');
    expect(r.type).toBe('composed');
    const c = r.codeCandidates![0]!;
    expect(c).toMatchObject({
      bizCd: 'PS',
      codeCls: '023',
      codeClsNm: '상태',
      logicalNm: '연구과제상태코드',
      physicalNm: 'RSCH_PRJ_STAT_CD',
      typeText: 'VARCHAR(10)',
      colComment: '연구과제상태코드(PS/023 상태)',
      score: 60,
    });
    const saved = await e.post(`${P}/tables`, {
      table: { bizAreaId: rpId, tableNm: 'RP_AC_S6', tableLogicalNm: 'S6', description: null },
      columns: [
        {
          columnId: null,
          logicalNm: c.logicalNm,
          physicalNm: c.physicalNm,
          isPk: true,
          dataType: c.dataType,
          dataLength: c.dataLength,
          dataScale: c.dataScale,
          isNullable: false,
          colComment: c.colComment,
          domainId: c.domainId,
          codeClsId: c.codeClsId,
          matchType: 'CODE',
        },
      ],
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    const id = (saved.body as TableSaveResponse).tableId;
    const d = (await e.get(`${P}/tables/${id}`)).body as TableDetail;
    expect(d.columns[0]).toMatchObject({
      codeClsId: c.codeClsId,
      matchType: 'CODE',
      codeCls: { bizCd: 'PS', codeCls: '023', codeClsNm: '상태' },
    });
    const row = await pool.query(
      'select code_cls_id, match_type from prj_column where table_id = $1',
      [id],
    );
    expect(row.rows[0]).toEqual({ code_cls_id: c.codeClsId, match_type: 'CODE' });
    await pool.query('delete from prj_table where table_id = $1', [id]);
  });

  it('exact 코드 컬럼(진행상태코드)에도 코드구분 후보가 붙는다(상위 3)', async () => {
    const e = await as('editor');
    const r = await ac(e, '진행상태코드');
    expect(r).toMatchObject({ type: 'exact', applied: { physicalNm: 'PRGRS_STAT_CD' } });
    expect(r.codeCandidates!.length).toBe(3);
  });
});

describe('T9.5 테이블 물리명 제안(실데이터)', () => {
  it('RP + 연구과제마스터 → RP_RSCH_PRJ_MAST(실데이터 마스터 = MAST, 승계 33 테이블은 MST — 정정 후보 T6.14), PS → PS_…', async () => {
    const e = await as('editor');
    const ps = (
      await pool.query(
        "select biz_area_id id from prj_biz_area where project_id = $1 and biz_cd = 'PS'",
        [rmsId],
      )
    ).rows[0].id as number;
    const rp = (
      await e.post(`${P}/tables/suggest-name`, { logicalNm: '연구과제마스터', bizAreaId: rpId })
    ).body as TableNameSuggestion;
    expect(rp).toMatchObject({ tableNm: 'RP_RSCH_PRJ_MAST', complete: true });
    const psName = (
      await e.post(`${P}/tables/suggest-name`, { logicalNm: '연구과제마스터', bizAreaId: ps })
    ).body as TableNameSuggestion;
    expect(psName.tableNm).toBe('PS_RSCH_PRJ_MAST');
    // 승계 33 테이블 논리명 → 제안 물리명 재현(마스터 MAST ↔ MST 차이를 뺀 나머지)
    const { rows } = await pool.query<{ table_nm: string; table_logical_nm: string }>(
      'select table_nm, table_logical_nm from prj_table where project_id = $1 order by table_nm',
      [rmsId],
    );
    let same = 0;
    for (const t of rows) {
      const s = (
        await e.post(`${P}/tables/suggest-name`, {
          logicalNm: t.table_logical_nm,
          bizAreaId: rpId,
          tableId: 1,
        })
      ).body as TableNameSuggestion;
      if (s.tableNm.replace(/_MAST(?=_|$)/, '_MST') === t.table_nm) same++;
    }
    process.stderr.write(
      `[autocomplete-rms] 33 테이블 물리명 제안 재현(MAST→MST 보정) ${same}/33\n`,
    );
    expect(same).toBe(33);
  });

  it('batch(Ctrl+V 20줄) 1회 요청', async () => {
    const e = await as('editor');
    const names = [
      '전자결재번호',
      '요청일자',
      '심의일자',
      '사용여부',
      '삭제여부',
      '정렬순서',
      '첨부파일ID',
      '비용금액',
      '과제관리번호',
      '접수일',
      '연구시작일자',
      '연구종료일자',
      '기안일자',
      '확정여부',
      '공개여부',
      '항목명',
      '항목코드',
      '변경내용',
      '필수여부',
      '과제명',
    ];
    const r = await e.post(`${P}/autocomplete/columns/batch`, {
      logicalNms: names,
      bizAreaId: rpId,
    });
    expect(r.status).toBe(200);
    const b = r.body as AutocompleteBatchResponse;
    expect(b.items).toHaveLength(20);
    expect(b.items.every((x) => x.applied !== null || x.type === 'similar')).toBe(true);
  });
});
