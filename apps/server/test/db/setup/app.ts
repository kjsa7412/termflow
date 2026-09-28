import type { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

/**
 * API 통합 테스트용 실제 앱(AppModule + configureApp: helmet·session(tf_session)·csrf·전역 가드).
 * ConfigModule.forRoot가 import 시점에 환경 변수를 검증하므로 env를 먼저 채우고 동적 import 한다.
 */
export const TEST_ADMIN_PASSWORD = 'Boot-strap#2026';
export const TEST_SESSION_SECRET = 'termflow-test-session-secret-0123456789abcdef';

export function setTestEnv(dbUrl: string, extra: Record<string, string> = {}): void {
  const url = new URL(dbUrl);
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    TERMFLOW_DB_URL: `postgres://${url.hostname}:${url.port}${url.pathname}`,
    TERMFLOW_DB_USER: decodeURIComponent(url.username),
    TERMFLOW_DB_PASSWORD: decodeURIComponent(url.password),
    DB_POOL_MAX: '4',
    TERMFLOW_ADMIN_LOGIN: 'admin',
    TERMFLOW_ADMIN_PASSWORD: TEST_ADMIN_PASSWORD,
    TERMFLOW_SESSION_SECRET: TEST_SESSION_SECRET,
    TERMFLOW_SESSION_TIMEOUT: '60m',
    ...extra,
  });
}

export async function createTestApp(extraModules: Type[] = []): Promise<INestApplication> {
  const { AppModule } = await import('../../../src/app.module.js');
  const { configureApp } = await import('../../../src/app.setup.js');
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, ...extraModules],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app);
  await app.init();
  return app;
}

/**
 * 쿠키 저장소를 가진 HTTP 클라이언트. 서버(앱)를 바꿔 끼워도 같은 쿠키로 요청할 수 있다(재기동 후 세션 유지 검증).
 * 비-GET 요청에는 `X-XSRF-TOKEN`을 자동으로 붙인다(SPA api/client.ts와 같은 규칙).
 */
export class Client {
  private readonly cookies = new Map<string, string>();
  csrf: string | undefined;

  constructor(private server: unknown) {}

  use(server: unknown): this {
    this.server = server;
    return this;
  }

  cookie(name: string): string | undefined {
    return this.cookies.get(name);
  }

  private store(setCookie: string[] | string | undefined): void {
    for (const line of Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []) {
      const [pair = ''] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  private header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async send(
    method: 'get' | 'post' | 'put' | 'delete',
    path: string,
    body?: object | string,
    opts: { csrf?: boolean; form?: boolean } = {},
  ): Promise<request.Response> {
    const agent = request(this.server as Parameters<typeof request>[0]);
    let req = agent[method](path).set('Cookie', this.header());
    if (method !== 'get' && opts.csrf !== false && this.csrf)
      req = req.set('X-XSRF-TOKEN', this.csrf);
    if (body !== undefined) {
      req = opts.form ? req.type('form').send(body) : req.send(body);
    }
    const res = await req;
    this.store(res.headers['set-cookie'] as unknown as string[] | undefined);
    return res;
  }

  get(path: string) {
    return this.send('get', path);
  }
  post(path: string, body?: object | string, opts?: { csrf?: boolean; form?: boolean }) {
    return this.send('post', path, body, opts);
  }
  put(path: string, body?: object, opts?: { csrf?: boolean }) {
    return this.send('put', path, body, opts);
  }
  delete(path: string, opts?: { csrf?: boolean }) {
    return this.send('delete', path, undefined, opts);
  }

  /** GET /auth/csrf → 토큰 보관. */
  async fetchCsrf(): Promise<string> {
    const res = await this.get('/api/v1/auth/csrf');
    this.csrf = (res.body as { token: string }).token;
    return this.csrf;
  }

  /** csrf → login(form). 성공하면 응답의 새 토큰으로 교체. */
  async login(loginId: string, password: string): Promise<request.Response> {
    if (!this.csrf) await this.fetchCsrf();
    const res = await this.post('/api/v1/auth/login', { loginId, password }, { form: true });
    if (res.status === 200) this.csrf = (res.body as { csrfToken: string }).csrfToken;
    return res;
  }
}
