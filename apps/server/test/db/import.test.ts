import type { INestApplication } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ImportApplyResponse, ImportPreview } from '@termflow/shared';
import { TermCacheRegistry } from '../../src/autocomplete/term-cache-registry.js';
import { ImportStore } from '../../src/standard/import/import-store.js';
import { Client, createTestApp, setTestEnv } from './setup/app.js';
import { FIXTURE_PASSWORD, useTestDb } from './setup/databases.js';
import { perfLimit } from './setup/perf.js';

// T6.9 엑셀 일괄 등록 2단계: 템플릿 → 업로드(미리보기 NEW/UPDATE/SKIP/ERROR) → 적용(오류 행 제외·batch_id·캐시 무효화 1회),
// kind 5종, 없는 업무구분 E_BIZ_AREA_NOT_FOUND, 파일 검사(매직 바이트·헤더·크기 413), 20,000행 미리보기 10초 벤치
const t = useTestDb('t_import', { fixture: 'std_small' });
let app: INestApplication;
const P = '/api/v1/projects/PRJA/standards';
let prja = 0;

beforeAll(async () => {
  setTestEnv(t.url, { TERMFLOW_UPLOAD_MAX_MB: '2' });
  app = await createTestApp();
  prja = (await t.pool.query("select project_id from tf_project where project_key = 'PRJA'"))
    .rows[0].project_id;
});
afterAll(async () => {
  await app?.close();
});

async function as(login: string): Promise<Client> {
  const c = new Client(app.getHttpServer());
  expect((await c.login(login, FIXTURE_PASSWORD)).status).toBe(200);
  return c;
}

/** 헤더 + 행으로 xlsx 버퍼를 만든다(테스트 입력 파일). */
async function xlsx(header: string[], rows: (string | number | null)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('data');
  ws.addRow(header);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function upload(c: Client, kind: string, buf: Buffer, name = 'upload.xlsx') {
  return c.upload(`${P}/${kind}/imports`, 'file', buf, name);
}

describe('템플릿 다운로드(§9.4)', () => {
  it('kind 5종: xlsx(헤더 순서 고정, 필수 열 굵게), 조회자 허용, 없는 kind 404', async () => {
    const v = await as('viewer');
    const expected: Record<string, string[]> = {
      'biz-areas': ['업무구분코드', '업무구분명', '테이블접두어', '정렬', '사용여부', '설명'],
      terms: ['한글용어', '물리약어', '설명', '동의어참조'],
      'domain-classes': ['접미어', '명칭', '타입', '길이', '스케일', '설명'],
      domains: [
        '명칭1',
        '명칭2',
        '명칭3',
        '명칭4',
        '명칭5',
        '명칭6',
        '명칭7',
        '수기타입',
        '수기길이',
        '수기스케일',
      ],
      'code-classes': ['업무구분코드', '코드구분', '코드구분명', '코드', '코드명', '정렬순서'],
    };
    for (const [kind, headers] of Object.entries(expected)) {
      const r = await v.download(`${P}/${kind}/imports/template`);
      expect(r.status, kind).toBe(200);
      expect(r.headers['content-type']).toMatch(/spreadsheetml/);
      expect(r.headers['content-disposition']).toMatch(/filename\*=UTF-8''/);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(r.body as unknown as ArrayBuffer);
      const row1 = wb.worksheets[0]!.getRow(1);
      expect(headers.map((_, i) => row1.getCell(i + 1).value)).toEqual(headers);
      expect(row1.getCell(1).font?.bold).toBe(true);
      expect(wb.worksheets[0]!.getRow(2).getCell(1).value).not.toBeNull(); // 예시 행
    }
    expect((await v.get(`${P}/nope/imports/template`)).status).toBe(404);
  });
});

describe('용어 일괄 등록(S1 엑셀)', () => {
  it('업로드 → 미리보기(신규·갱신·동일·오류 + 경고) → 적용(오류 제외, batch_id, 캐시 무효화 1회)', async () => {
    const pa = await as('pa');
    const buf = await xlsx(
      ['한글용어*', '물리약어*', '설명', '동의어참조'],
      [
        ['위원회', 'CMTE', 'Committee', null], // NEW
        ['용어1', 'PA_T1', '새 설명', null], // UPDATE(설명)
        ['용어2', 'PA_T2', null, null], // SKIP(동일)
        ['연구과제', 'RSCH-PRJ', null, null], // ERROR 형식
        [null, 'RESP', null, null], // ERROR 한글 공란
        ['위원회', 'CMTE2', null, null], // ERROR 파일 내 중복
        ['위원', 'CMTE', null, null], // NEW + 경고(같은 물리약어)
        [null, null, null, null], // 빈 행 무시
      ],
    );
    const up = await upload(pa, 'terms', buf, '용어_일괄등록.xlsx');
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const pv = up.body as ImportPreview;
    expect(pv.fileName).toBe('용어_일괄등록.xlsx');
    expect(pv.summary).toEqual({ new: 2, update: 1, skip: 1, error: 3, warn: 2 });
    expect(pv.items.map((r) => [r.rowNo, r.status])).toEqual([
      [2, 'NEW'],
      [3, 'UPDATE'],
      [4, 'SKIP'],
      [5, 'ERROR'],
      [6, 'ERROR'],
      [7, 'ERROR'],
      [8, 'NEW'],
    ]);
    expect(pv.items[1]!.changes).toEqual({ description: ['설명 1', '새 설명'] });
    expect(pv.items[3]!.errors[0]!.code).toBe('E_TERM_PHYSICAL_FORMAT');
    expect(pv.items[5]!.errors[0]!.code).toBe('E_IMPORT_FILE_DUP');
    expect(pv.items[6]!.warnings[0]!.code).toBe('W_TERM_PHYSICAL_SHARED');
    // 페이지·필터(GET)
    const errs = (await pa.get(`${P}/imports/${pv.importId}?status=ERROR`)).body as ImportPreview;
    expect(errs.total).toBe(3);
    // 적용 전에는 DB 변경 없음
    expect(
      (
        await t.pool.query(
          "select count(*)::int n from std_term where project_id = $1 and term_kor = '위원회'",
          [prja],
        )
      ).rows[0].n,
    ).toBe(0);
    // skipErrors=false → 422
    const strict = await pa.post(`${P}/imports/${pv.importId}/apply`, { skipErrors: false });
    expect(strict.status).toBe(422);
    expect(strict.body.errors[0].code).toBe('E_IMPORT_HAS_ERRORS');
    const cache = app.get(TermCacheRegistry);
    const n0 = cache.recentInvalidations().length;
    const ap = await pa.post(`${P}/imports/${pv.importId}/apply`, {});
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    const res = ap.body as ImportApplyResponse;
    expect(res).toMatchObject({ applied: { new: 2, update: 1 }, skipped: 1, errors: 3 });
    expect(cache.recentInvalidations().length).toBe(n0 + 1);
    const audit = await t.pool.query(
      'select action, count(*)::int n from std_audit_log where batch_id = $1 group by action',
      [res.batchId],
    );
    expect(audit.rows).toEqual([{ action: 'IMPORT', n: 3 }]);
    const terms = await t.pool.query(
      "select term_kor, term_physical, description, status from std_term where project_id = $1 and term_kor in ('위원회', '위원', '용어1') order by term_id",
      [prja],
    );
    expect(terms.rows).toEqual([
      { term_kor: '용어1', term_physical: 'PA_T1', description: '새 설명', status: 'APPROVED' },
      { term_kor: '위원회', term_physical: 'CMTE', description: 'Committee', status: 'APPROVED' },
      { term_kor: '위원', term_physical: 'CMTE', description: null, status: 'APPROVED' },
    ]);
    // 적용 후 미리보기는 사라진다
    expect((await pa.get(`${P}/imports/${pv.importId}`)).status).toBe(404);
  });

  it('다른 사용자·다른 프로젝트의 importId는 404, 취소(DELETE) 후 404, 편집자 업로드 403', async () => {
    const pa = await as('pa');
    const buf = await xlsx(
      ['한글용어', '물리약어', '설명', '동의어참조'],
      [['취소용', 'CNCL', null, null]],
    );
    const pv = (await upload(pa, 'terms', buf)).body as ImportPreview;
    expect((await (await as('sysadmin')).get(`${P}/imports/${pv.importId}`)).status).toBe(404);
    expect((await pa.get(`/api/v1/projects/PRJB/standards/imports/${pv.importId}`)).status).toBe(
      404,
    );
    expect((await pa.delete(`${P}/imports/${pv.importId}`)).status).toBe(204);
    expect((await pa.post(`${P}/imports/${pv.importId}/apply`, {})).status).toBe(404);
    const ed = await as('editor');
    expect((await upload(ed, 'terms', buf)).status).toBe(403);
  });

  it('파일 검사: xlsx 아님 422, 헤더 다름 422, 데이터 없음 422, 크기 상한 초과 413', async () => {
    const pa = await as('pa');
    const notXlsx = await upload(pa, 'terms', Buffer.from('a,b\n1,2\n'), 'x.csv');
    expect(notXlsx.status).toBe(422);
    expect(notXlsx.body.errors[0].code).toBe('E_IMPORT_FILE');
    const hdr = await upload(pa, 'terms', await xlsx(['용어', '약어'], [['a', 'B']]));
    expect(hdr.status).toBe(422);
    expect(hdr.body.errors[0].code).toBe('E_IMPORT_HEADER');
    const empty = await upload(
      pa,
      'terms',
      await xlsx(['한글용어', '물리약어', '설명', '동의어참조'], []),
    );
    expect(empty.body.errors[0].code).toBe('E_IMPORT_EMPTY');
    const big = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.alloc(3 * 1024 * 1024),
    ]);
    const tooBig = await upload(pa, 'terms', big);
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.code).toBe('E_UPLOAD_TOO_LARGE');
  });
});

describe('kind별 규칙', () => {
  it('code-classes: 없는 업무구분 E_BIZ_AREA_NOT_FOUND, 새 코드구분 자동 생성, 코드구분명 충돌 뒤 행 ERROR', async () => {
    const pa = await as('pa');
    const buf = await xlsx(
      ['업무구분코드', '코드구분', '코드구분명', '코드', '코드명', '정렬순서'],
      [
        ['ZZ', '010', '없는업무', '1', '가', 1], // ERROR 업무구분 없음
        ['RP', '800', '신규구분', '1', '가', 1], // NEW(코드구분도 새로)
        ['RP', '800', '신규구분', '2', '나', 2], // NEW
        ['RP', '800', '다른이름', '3', '다', 3], // ERROR 이름 충돌
        ['RP', 'RP001', '코드구분1', '01', '코드1', 1], // SKIP(동일)
        ['RP', 'RP001', '코드구분1', '02', '코드2(변경)', 2], // UPDATE
      ],
    );
    const pv = (await upload(pa, 'code-classes', buf)).body as ImportPreview;
    expect(pv.items.map((r) => r.status)).toEqual([
      'ERROR',
      'NEW',
      'NEW',
      'ERROR',
      'SKIP',
      'UPDATE',
    ]);
    expect(pv.items[0]!.errors[0]!.code).toBe('E_BIZ_AREA_NOT_FOUND');
    expect(pv.items[3]!.errors[0]!.code).toBe('E_CODE_CLS_NM_CONFLICT');
    const ap = (await pa.post(`${P}/imports/${pv.importId}/apply`, {})).body as ImportApplyResponse;
    expect(ap.applied).toEqual({ new: 2, update: 1 });
    const c = await t.pool.query(
      `select c.code_cls_nm, count(x.code_id)::int n from std_code_cls c join prj_biz_area b using (biz_area_id)
         left join std_code x on x.code_cls_id = c.code_cls_id
        where c.project_id = $1 and b.biz_cd = 'RP' and c.code_cls = '800' group by 1`,
      [prja],
    );
    expect(c.rows).toEqual([{ code_cls_nm: '신규구분', n: 2 }]);
    const pb = await t.pool.query(
      "select count(*)::int n from prj_biz_area where project_id = $1 and biz_cd = 'ZZ'",
      [prja],
    );
    expect(pb.rows[0].n).toBe(0); // 업무구분 자동 생성 없음
  });

  it('biz-areas: 테이블이 있는 업무구분의 접두어 변경·사용 중지 ERROR(E_BIZ_AREA_IN_USE), 신규 접두어 기본값', async () => {
    const pa = await as('pa');
    const buf = await xlsx(
      ['업무구분코드', '업무구분명', '테이블접두어', '정렬', '사용여부', '설명'],
      [
        ['RP', '연구과제', 'RX_', null, null, null],
        ['RP', '연구과제', null, null, 'N', null],
        ['CM', '공통', null, 9, 'Y', null],
        ['PS', '인사(개명)', null, null, null, null],
      ],
    );
    const pv = (await upload(pa, 'biz-areas', buf)).body as ImportPreview;
    expect(pv.items.map((r) => r.status)).toEqual(['ERROR', 'ERROR', 'NEW', 'UPDATE']);
    expect(pv.items[0]!.errors.map((e) => e.code)).toEqual(['E_BIZ_AREA_IN_USE']);
    expect(pv.items[1]!.errors.map((e) => e.code)).toEqual([
      'E_IMPORT_FILE_DUP',
      'E_BIZ_AREA_IN_USE',
    ]);
    expect(pv.items[2]!.values['tablePrefix']).toBe('CM_');
    await pa.post(`${P}/imports/${pv.importId}/apply`, {});
    const b = await t.pool.query(
      'select biz_cd, biz_nm, table_prefix from prj_biz_area where project_id = $1 order by biz_cd',
      [prja],
    );
    expect(b.rows).toEqual([
      { biz_cd: 'CM', biz_nm: '공통', table_prefix: 'CM_' },
      { biz_cd: 'PS', biz_nm: '인사(개명)', table_prefix: 'PS_' },
      { biz_cd: 'RP', biz_nm: '연구과제', table_prefix: 'RP_' },
    ]);
  });

  it('domain-classes·domains: 타입 규칙 ERROR, L1 계산 열·미등록 조각 경고, 수기 타입 MANUAL', async () => {
    const pa = await as('pa');
    const cls = await xlsx(
      ['접미어', '명칭', '타입', '길이', '스케일', '설명'],
      [
        ['MEMO', '메모', 'varchar', 500, null, null],
        ['RT', '비율', 'NUMERIC', 3, 5, null], // ERROR 스케일 > 정밀도
        ['NO2', '번호', 'INTEGER', null, null, null], // 별칭 → INT
        ['BAD', '나쁨', 'STRING', null, null, null], // ERROR 타입
      ],
    );
    const pc = (await upload(pa, 'domain-classes', cls)).body as ImportPreview;
    expect(pc.items.map((r) => r.status)).toEqual(['NEW', 'ERROR', 'NEW', 'ERROR']);
    expect(pc.items[0]!.values['typeText']).toBe('VARCHAR(500)');
    expect(pc.items[2]!.values['colType']).toBe('INT');
    expect(pc.items[3]!.errors[0]!.code).toBe('E_TYPE_UNKNOWN');
    expect((await pa.post(`${P}/imports/${pc.importId}/apply`, {})).body.applied).toEqual({
      new: 2,
      update: 0,
    });

    const dom = await xlsx(
      [
        '명칭1',
        '명칭2',
        '명칭3',
        '명칭4',
        '명칭5',
        '명칭6',
        '명칭7',
        '수기타입',
        '수기길이',
        '수기스케일',
      ],
      [
        ['용어3', '용어4', null, null, null, null, null, 'VARCHAR', 30, null], // NEW MANUAL
        ['용어3', '미등록조각', null, null, null, null, null, null, null, null], // NEW 경고
        [null, '용어4', null, null, null, null, null, null, null, null], // ERROR 명칭1
      ],
    );
    const pd = (await upload(pa, 'domains', dom)).body as ImportPreview;
    expect(pd.columns.filter((c) => c.computed).map((c) => c.key)).toEqual([
      'logicalNm',
      'physicalNm',
      'typeText',
    ]);
    expect(pd.items.map((r) => r.status)).toEqual(['NEW', 'NEW', 'ERROR']);
    expect(pd.items[0]!.values).toMatchObject({
      logicalNm: '용어3용어4',
      physicalNm: 'PA_T3_PA_T4',
      typeText: 'VARCHAR(30)',
    });
    expect(pd.items[1]!.warnings[0]!.code).toBe('W_TERM_UNREGISTERED');
    expect(pd.items[2]!.errors[0]!.code).toBe('E_DOMAIN_PARTS_EMPTY');
    await pa.post(`${P}/imports/${pd.importId}/apply`, {});
    const d = await t.pool.query(
      "select logical_nm, physical_nm, type_source, review_yn from std_domain where project_id = $1 and logical_nm like '용어3%' and logical_nm not like '%분류%' order by logical_nm",
      [prja],
    );
    expect(d.rows).toEqual([
      { logical_nm: '용어3미등록조각', physical_nm: null, type_source: 'AUTO', review_yn: true },
      {
        logical_nm: '용어3용어4',
        physical_nm: 'PA_T3_PA_T4',
        type_source: 'MANUAL',
        review_yn: false,
      },
    ]);
  });
});

describe('미리보기 보관소(TTL 30분·사용자당 5건)', () => {
  it('사용자당 5건 초과 시 가장 오래된 미리보기를 버리고, TTL이 지나면 없다', () => {
    const s = new ImportStore();
    const base = {
      projectId: 1,
      kind: 'terms' as const,
      fileName: 'a',
      elapsedMs: 0,
      raw: [],
      rows: [],
      summary: { new: 0, update: 0, skip: 0, error: 0, warn: 0 },
    };
    const ids = [0, 1, 2, 3, 4, 5].map((i) => s.put({ ...base, userId: 7 }, 1000 + i).importId);
    expect(s.countFor(7)).toBe(5);
    expect(s.get(ids[0]!, 7, 1, 2000)).toBeUndefined();
    expect(s.get(ids[5]!, 7, 1, 2000)).toBeDefined();
    expect(s.get(ids[5]!, 8, 1, 2000)).toBeUndefined(); // 다른 사용자
    expect(s.get(ids[5]!, 7, 1, 1005 + 30 * 60_000)).toBeUndefined(); // 만료
    s.onModuleDestroy();
  });
});

describe('성능(§12.1): 일괄 등록 20,000행 미리보기 10초 이내', () => {
  it('용어 20,000행 업로드 → 미리보기 → 적용', async () => {
    const pa = await as('pa');
    const rows = Array.from({ length: 20_000 }, (_, i) => [
      `벤치용어${i}`,
      `BNCH_${i}`,
      `설명 ${i}`,
      null,
    ]);
    const buf = await xlsx(['한글용어', '물리약어', '설명', '동의어참조'], rows);
    const t0 = performance.now();
    const up = await upload(pa, 'terms', buf);
    const previewMs = Math.round(performance.now() - t0);
    expect(up.status, JSON.stringify(up.body).slice(0, 300)).toBe(201);
    const pv = up.body as ImportPreview;
    expect(pv.summary.new).toBe(20_000);
    expect(pv.items).toHaveLength(100);
    const t1 = performance.now();
    const ap = await pa.post(`${P}/imports/${pv.importId}/apply`, {});
    const applyMs = Math.round(performance.now() - t1);
    expect(ap.status).toBe(200);
    expect(ap.body.applied.new).toBe(20_000);
    console.log(
      `[bench] 용어 20,000행: 파일 ${(buf.length / 1024).toFixed(0)}KB · 미리보기(업로드 포함) ${previewMs}ms(서버 ${pv.elapsedMs}ms) · 적용 ${applyMs}ms`,
    );
    expect(previewMs).toBeLessThan(perfLimit(10_000, 30_000));
  });
});
