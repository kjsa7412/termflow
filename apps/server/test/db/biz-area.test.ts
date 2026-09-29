import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BizAreaItem } from '@termflow/shared';
import { TermCacheRegistry } from '../../src/autocomplete/term-cache-registry.js';
import { Client, createTestApp, setTestEnv } from './setup/app.js';
import { FIXTURE_PASSWORD, useTestDb } from './setup/databases.js';

// T5.7 업무구분 API: 잠금 규칙 4종(테이블 있으면 코드·접두어 변경·사용 중지·삭제 409), CASCADE, 감사, 캐시 무효화 호출
const t = useTestDb('t_biz_area', { fixture: 'std_small' });
let app: INestApplication;
let prjaId: number;

beforeAll(async () => {
  setTestEnv(t.url);
  app = await createTestApp();
  prjaId = (await t.pool.query("select project_id from tf_project where project_key = 'PRJA'"))
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
const byCd = (list: BizAreaItem[], cd: string) => list.find((b) => b.bizCd === cd)!;
const base = { bizNm: '연구과제', tablePrefix: 'RP_', sortNo: 1, useYn: true, description: null };

describe('업무구분(T5.7)', () => {
  it('목록(조회자): 테이블 수·코드구분 수·잠금·출처', async () => {
    const r = await (await as('viewer')).get('/api/v1/projects/PRJA/biz-areas');
    expect(r.status).toBe(200);
    const list = r.body as BizAreaItem[];
    expect(list.map((b) => [b.bizCd, b.tableCnt, b.codeClsCnt, b.locked])).toEqual([
      ['RP', 1, 3, true],
      ['PS', 0, 2, false],
    ]);
    expect(byCd(list, 'RP').origin).toEqual({ projectKey: 'STDS', projectNm: '소형 표준 템플릿' });
  });

  it('추가: 접두어 기본값 코드_, 중복 409 E_BIZ_AREA_DUP, 형식 400, 편집자 403, 감사 INSERT, 캐시 무효화 호출', async () => {
    const pa = await as('pa');
    const cache = app.get(TermCacheRegistry);
    const before = cache.recentInvalidations().length;
    const r = await pa.post('/api/v1/projects/PRJA/biz-areas', {
      bizCd: 'CM',
      bizNm: '공통',
      sortNo: 3,
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ bizCd: 'CM', tablePrefix: 'CM_', locked: false, origin: null });
    expect(cache.recentInvalidations().length).toBe(before + 1);
    expect(cache.recentInvalidations().at(-1)).toBe(prjaId);
    const none = await pa.post('/api/v1/projects/PRJA/biz-areas', {
      bizCd: 'NP',
      bizNm: '접두어 없음',
      tablePrefix: null,
    });
    expect(none.body.tablePrefix).toBeNull();
    const dup = await pa.post('/api/v1/projects/PRJA/biz-areas', { bizCd: 'CM', bizNm: '또' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('E_BIZ_AREA_DUP');
    expect(
      (await pa.post('/api/v1/projects/PRJA/biz-areas', { bizCd: 'c', bizNm: 'x' })).status,
    ).toBe(400);
    expect(
      (
        await (
          await as('editor')
        ).post('/api/v1/projects/PRJA/biz-areas', { bizCd: 'ZZ', bizNm: 'x' })
      ).status,
    ).toBe(403);
    const a = await t.pool.query(
      "select action, after_json->>'bizCd' cd, actor from std_audit_log where entity_type = 'BIZ_AREA' and entity_id = $1",
      [r.body.bizAreaId],
    );
    expect(a.rows).toEqual([{ action: 'INSERT', cd: 'CM', actor: 'pa' }]);
  });

  it('잠금 4종: 테이블이 있는 RP는 코드·접두어·사용 중지·삭제 409 E_BIZ_AREA_IN_USE, 이름·정렬은 변경 가능', async () => {
    const pa = await as('pa');
    const rp = byCd((await pa.get('/api/v1/projects/PRJA/biz-areas')).body, 'RP');
    const url = `/api/v1/projects/PRJA/biz-areas/${rp.bizAreaId}`;
    const code = await pa.put(url, { ...base, bizCd: 'RX' });
    expect(code.status).toBe(409);
    expect(code.body).toMatchObject({ code: 'E_BIZ_AREA_IN_USE', tableCnt: 1, fields: ['코드'] });
    expect((await pa.put(url, { ...base, bizCd: 'RP', tablePrefix: 'R_' })).body.code).toBe(
      'E_BIZ_AREA_IN_USE',
    );
    expect((await pa.put(url, { ...base, bizCd: 'RP', useYn: false })).body.code).toBe(
      'E_BIZ_AREA_IN_USE',
    );
    const del = await pa.delete(url);
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('E_BIZ_AREA_IN_USE');
    const ok = await pa.put(url, { ...base, bizCd: 'RP', bizNm: '연구과제(개명)', sortNo: 9 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      bizNm: '연구과제(개명)',
      sortNo: 9,
      tablePrefix: 'RP_',
      locked: true,
    });
    // 접두어 생략(undefined)은 유지
    const keep = await pa.put(url, { bizCd: 'RP', bizNm: '연구과제', sortNo: 1, useYn: true });
    expect(keep.body.tablePrefix).toBe('RP_');
  });

  it('테이블 없는 업무구분: 코드·접두어 변경·사용 중지 가능 → 삭제 미리보기 건수 → 삭제 CASCADE·컬럼 참조 SET NULL', async () => {
    const pa = await as('pa');
    const ps = byCd((await pa.get('/api/v1/projects/PRJA/biz-areas')).body, 'PS');
    const url = `/api/v1/projects/PRJA/biz-areas/${ps.bizAreaId}`;
    const up = await pa.put(url, {
      bizCd: 'HR',
      bizNm: '인사',
      tablePrefix: 'HR_',
      sortNo: 2,
      useYn: false,
      description: '인사',
    });
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ bizCd: 'HR', tablePrefix: 'HR_', useYn: false });
    // 다른 업무구분(RP) 테이블 컬럼이 HR의 코드구분을 참조하게 한다
    await t.pool.query(
      `update prj_column set code_cls_id = (select min(code_cls_id) from std_code_cls where biz_area_id = $1)
        where project_id = $2 and col_seq = 2`,
      [ps.bizAreaId, prjaId],
    );
    const pv = await pa.get(`${url}/delete-preview`);
    expect(pv.body).toEqual({ tableCnt: 0, codeClsCnt: 2, codeCnt: 12, referencingColumnCnt: 1 });
    const del = await pa.delete(url);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ deletedCodeCls: 2, deletedCodes: 12, affectedColumns: 1 });
    const left = await t.pool.query(
      `select (select count(*) from std_code_cls where biz_area_id = $1)::int cls,
              (select code_cls_id from prj_column where project_id = $2 and col_seq = 2) col`,
      [ps.bizAreaId, prjaId],
    );
    expect(left.rows[0]).toEqual({ cls: 0, col: null });
    const a = await t.pool.query(
      "select action from std_audit_log where entity_type = 'BIZ_AREA' and entity_id = $1 order by audit_id",
      [ps.bizAreaId],
    );
    expect(a.rows.map((r) => r.action)).toEqual(['UPDATE', 'DELETE']);
    expect((await pa.get(`${url}/delete-preview`)).status).toBe(404);
  });

  it('다른 프로젝트의 업무구분 ID는 404(교차 프로젝트 참조 금지), 템플릿은 SA가 편집', async () => {
    const pa = await as('pa');
    const prjb = (await pa.get('/api/v1/projects/PRJB/biz-areas')).body as BizAreaItem[];
    const r = await pa.put(`/api/v1/projects/PRJA/biz-areas/${prjb[0]!.bizAreaId}`, {
      ...base,
      bizCd: 'RP',
    });
    expect(r.status).toBe(404);
    const sa = await as('sysadmin');
    expect(
      (await sa.post('/api/v1/projects/STDS/biz-areas', { bizCd: 'CM', bizNm: '공통' })).status,
    ).toBe(201);
  });
});
