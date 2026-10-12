import type { INestApplication } from '@nestjs/common';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RouteCatalog } from '../../src/mcp/route-catalog.js';
import { Client, createTestApp, setTestEnv } from './setup/app.js';
import { FIXTURE_PASSWORD, useTestDb } from './setup/databases.js';

// CR-18 외부 연동: 개인 접근 토큰(Bearer) + /mcp(무상태 Streamable HTTP). std_small: sysadmin·pa·editor·viewer, PRJA·PRJB.

const t = useTestDb('t_mcp', { fixture: 'std_small' });
let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  setTestEnv(t.url, { TERMFLOW_MCP_ENABLED: 'true' });
  app = await createTestApp();
  // 도구 호출은 같은 서버 REST를 루프백으로 부른다 → 실제 포트로 연다.
  await app.listen(0, '127.0.0.1');
  const addr = app.getHttpServer().address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => {
  await app?.close();
});

const server = () => app.getHttpServer();

async function login(loginId: string): Promise<Client> {
  const c = new Client(server());
  expect((await c.login(loginId, FIXTURE_PASSWORD)).status).toBe(200);
  return c;
}

async function issue(loginId: string, tokenNm = '테스트'): Promise<string> {
  const c = await login(loginId);
  const res = await c.post('/api/v1/me/tokens', { tokenNm, expiresInDays: 30 });
  expect(res.status).toBe(201);
  return (res.body as { token: string }).token;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function mcp(token: string): Promise<McpClient> {
  const client = new McpClient({ name: 'termflow-test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: bearer(token) },
    }),
  );
  return client;
}

function textOf(r: unknown): string {
  const content = (r as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((c) => c.text ?? '').join('');
}

describe('개인 접근 토큰(/me/tokens)', () => {
  it('발급: 원문은 응답 1회, DB에는 해시만, 목록은 앞부분·ACTIVE', async () => {
    const c = await login('editor');
    const res = await c.post('/api/v1/me/tokens', { tokenNm: '편집기 연동' });
    expect(res.status).toBe(201);
    const { token, item } = res.body as { token: string; item: { tokenPrefix: string } };
    expect(token).toMatch(/^tfp_[A-Za-z0-9_-]{43}$/);
    expect(token.startsWith(item.tokenPrefix)).toBe(true);
    const { rows } = await t.pool.query<{ token_hash: string; expires_at: string }>(
      "select token_hash, expires_at::text from tf_api_token where token_nm = '편집기 연동'",
    );
    expect(rows[0]!.token_hash).toHaveLength(64);
    expect(rows[0]!.token_hash).not.toContain(token.slice(4));
    const days = (new Date(rows[0]!.expires_at).getTime() - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(90);

    const list = await c.get('/api/v1/me/tokens');
    expect(list.body).toMatchObject({ enabled: true, mcpPath: '/mcp' });
    const mine = (list.body as { items: { tokenNm: string; status: string }[] }).items;
    expect(mine.find((i) => i.tokenNm === '편집기 연동')?.status).toBe('ACTIVE');
  });

  it('남의 토큰 폐기는 404, 본인 폐기 후 401', async () => {
    const token = await issue('viewer', '폐기용');
    const viewer = await login('viewer');
    const items = (await viewer.get('/api/v1/me/tokens')).body as {
      items: { tokenId: number; tokenNm: string }[];
    };
    const id = items.items.find((i) => i.tokenNm === '폐기용')!.tokenId;
    const other = await login('editor');
    expect((await other.delete(`/api/v1/me/tokens/${id}`)).status).toBe(404);
    expect((await viewer.delete(`/api/v1/me/tokens/${id}`)).status).toBe(204);
    const res = await request(server()).get('/api/v1/me').set(bearer(token));
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'E_TOKEN_INVALID' });
  });
});

describe('Bearer로 REST 호출', () => {
  it('세션·CSRF 없이 사용자 권한 그대로, 감사 주체 = 토큰 주인', async () => {
    const token = await issue('editor');
    const me = await request(server()).get('/api/v1/me').set(bearer(token));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ user: { loginId: 'editor' } });
    expect(me.headers['set-cookie']).toBeUndefined();

    // POST도 CSRF 헤더 없이
    const term = await request(server())
      .post('/api/v1/projects/PRJA/standards/terms/inline')
      .set(bearer(token))
      .send({ termKor: '토큰용어', termPhysical: 'TKNTRM' });
    expect(term.status).toBe(201);
    const { rows } = await t.pool.query<{ created_by: string; status: string }>(
      "select created_by, status from std_term where term_kor = '토큰용어'",
    );
    expect(rows[0]).toEqual({ created_by: 'editor', status: 'PENDING' });

    // 역할 밖: 편집자는 용어 바로 등록(ADMIN) 403, 비멤버 프로젝트 404
    const create = await request(server())
      .post('/api/v1/projects/PRJA/standards/terms')
      .set(bearer(token))
      .send({ termKor: '토큰용어2', termPhysical: 'TKNTWO' });
    expect(create.status).toBe(403);
    expect((await request(server()).get('/api/v1/projects/PRJB').set(bearer(token))).status).toBe(
      404,
    );
  });

  it('무효·만료·비활성 401(WWW-Authenticate), 금지 경로 403', async () => {
    const bad = await request(server()).get('/api/v1/me').set(bearer('tfp_nope'));
    expect(bad.status).toBe(401);
    expect(bad.headers['www-authenticate']).toMatch(/^Bearer/);

    const token = await issue('pa', '만료용');
    for (const path of ['/api/v1/me/tokens', '/api/v1/auth/csrf']) {
      const res = await request(server()).get(path).set(bearer(token));
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'E_TOKEN_NOT_ALLOWED' });
    }
    expect(
      (await request(server()).put('/api/v1/me/password').set(bearer(token)).send({})).status,
    ).toBe(403);

    await t.pool.query(
      "update tf_api_token set expires_at = CURRENT_TIMESTAMP - interval '1 second' where token_nm = '만료용'",
    );
    expect((await request(server()).get('/api/v1/me').set(bearer(token))).status).toBe(401);

    const token2 = await issue('pa', '비활성용');
    await t.pool.query("update tf_user set is_active = false where login_id = 'pa'");
    try {
      expect((await request(server()).get('/api/v1/me').set(bearer(token2))).status).toBe(401);
    } finally {
      await t.pool.query("update tf_user set is_active = true where login_id = 'pa'");
    }
  });

  it('사용자 비활성화·비밀번호 초기화 시 토큰 폐기', async () => {
    await issue('viewer', '초기화용');
    const admin = await login('sysadmin');
    const { rows } = await t.pool.query<{ user_id: number }>(
      "select user_id from tf_user where login_id = 'viewer'",
    );
    const res = await admin.post(`/api/v1/admin/users/${rows[0]!.user_id}/reset-password`);
    expect(res.status).toBe(200);
    const left = await t.pool.query(
      "select 1 from tf_api_token t join tf_user u using (user_id) where u.login_id = 'viewer' and t.revoked_at is null",
    );
    expect(left.rowCount).toBe(0);
  });
});

describe('/mcp', () => {
  it('도구 목록이 REST 라우트를 빠짐없이 덮는다(이름·제외 사유 누락 0)', () => {
    const scan = app.get(RouteCatalog).result();
    expect(scan.missing).toEqual([]);
    expect(scan.stale).toEqual([]);
    const names = scan.tools.map((x) => x.name);
    expect(new Set(names).size).toBe(names.length);
    for (const x of scan.tools) {
      expect(x.name).toMatch(/^[a-z][a-z0-9_]{2,63}$/);
      expect(x.inputSchema['type']).toBe('object');
    }
    const create = scan.tools.find((x) => x.name === 'table_create')!;
    expect(create).toMatchObject({ method: 'POST', path: '/api/v1/projects/:projectKey/tables' });
    expect(create.inputSchema['required']).toEqual(['projectKey', 'body']);
    expect(JSON.stringify(create.inputSchema)).toContain('tableLogicalNm');
  });

  it('initialize·tools/list: 안내문, 시스템 관리자 도구는 관리자에게만', async () => {
    const editor = await mcp(await issue('editor'));
    expect(editor.getInstructions()).toContain('테이블 설계 순서');
    const names = (await editor.listTools()).tools.map((x) => x.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'columns_autocomplete',
        'table_create',
        'term_request',
        'domain_create',
      ]),
    );
    expect(names).not.toContain('admin_users_list');
    await editor.close();

    const admin = await mcp(await issue('sysadmin'));
    expect((await admin.listTools()).tools.map((x) => x.name)).toContain('admin_users_list');
    await admin.close();
  });

  it('tools/call: REST와 같은 결과·권한, 오류는 isError', async () => {
    const client = await mcp(await issue('editor'));
    const me = await client.callTool({ name: 'whoami', arguments: {} });
    expect(me.isError).toBeFalsy();
    expect(JSON.parse(textOf(me))).toMatchObject({ user: { loginId: 'editor' } });

    const terms = await client.callTool({
      name: 'terms_list',
      arguments: { projectKey: 'PRJA', query: { q: '토큰용어' } },
    });
    expect(textOf(terms)).toContain('TKNTRM');

    const ac = await client.callTool({
      name: 'columns_autocomplete',
      arguments: { projectKey: 'PRJA', body: { logicalNms: ['용어1', '없는말'] } },
    });
    const items = (JSON.parse(textOf(ac)) as { items: { input: string; type: string }[] }).items;
    expect(items.map((i) => i.input)).toEqual(['용어1', '없는말']);

    const invalid = await client.callTool({
      name: 'table_create',
      arguments: {
        projectKey: 'PRJA',
        body: { table: { bizAreaId: null, tableNm: 'X', tableLogicalNm: '시험' }, columns: [] },
      },
    });
    expect(invalid.isError).toBe(true);
    expect(textOf(invalid)).toMatch(/^HTTP 4\d\d /);

    const forbidden = await client.callTool({
      name: 'project_get',
      arguments: { projectKey: 'PRJB' },
    });
    expect(forbidden.isError).toBe(true);
    expect(textOf(forbidden)).toContain('HTTP 404');

    const ddl = await client.callTool({
      name: 'tables_list',
      arguments: { projectKey: 'PRJA' },
    });
    const first = (JSON.parse(textOf(ddl)) as { items: { tableId: number }[] }).items[0]!;
    const sql = await client.callTool({
      name: 'table_ddl',
      arguments: { projectKey: 'PRJA', id: first.tableId },
    });
    expect(sql.isError).toBeFalsy();
    expect(textOf(sql)).toMatch(/CREATE TABLE/i);
    await client.close();
  });

  it('프롬프트 design_table', async () => {
    const client = await mcp(await issue('editor'));
    const list = await client.listPrompts();
    expect(list.prompts.map((p) => p.name)).toEqual(['design_table']);
    // 공백으로 나뉘는 클라이언트 대비: 한 단어 인자(키·업무구분)가 앞, 요구사항은 선택(마지막)
    expect(list.prompts[0]!.arguments!.map((a) => [a.name, a.required])).toEqual([
      ['projectKey', true],
      ['bizArea', false],
      ['requirement', false],
    ]);
    const p = await client.getPrompt({
      name: 'design_table',
      arguments: { projectKey: 'PRJA', bizArea: 'RP', requirement: '교육 신청 이력' },
    });
    const msg = p.messages[0]!.content as { text: string };
    expect(msg.text).toContain('PRJA');
    expect(msg.text).toContain('업무구분: RP');
    expect(msg.text).toContain('교육 신청 이력');
    // 요구사항 없이 부르면 먼저 묻게 한다
    const bare = await client.getPrompt({
      name: 'design_table',
      arguments: { projectKey: 'PRJA' },
    });
    expect((bare.messages[0]!.content as { text: string }).text).toContain(
      '사용자에게 먼저 묻는다',
    );
    await client.close();
  });

  it('세션 쿠키만으로는 /mcp를 쓸 수 없다', async () => {
    const c = await login('editor');
    const res = await c.post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
    expect((await request(server()).post('/mcp').send({})).status).toBe(401);
  });
});
