#!/usr/bin/env node
// 동시 사용자 부하 측정(T10.9, 설계서 §12.1 "동시 사용자 20명 · 커넥션 풀 10"): 실행 중인 서버(dev 8080)에
// 세션 N개로 로그인해 각자 자동완성 → 테이블 상세(편집기 로드) → 목록 20행을 반복하고 요청별 p50·p95·최대·오류를 낸다.
// 사용법: node scripts/load-concurrency.mjs [사용자 수=20] [초=30] [생각 시간 ms=0] [기준 URL=http://localhost:8080]
// 생각 시간 = 한 사용자의 요청 사이 대기(0 = 쉬지 않고 연속 요청하는 포화 측정, 1000 = 1초마다 Enter 치는 빠른 편집자).
// 계정: 루트 .env의 TERMFLOW_ADMIN_LOGIN + TERMFLOW_ADMIN_DEV_CURRENT_PASSWORD(값은 출력하지 않는다). 데이터는 바꾸지 않는다(읽기·자동완성만).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(path.join(ROOT, '.env'), 'utf8')
    .split(/\r?\n/)
    .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const USERS = Number(process.argv[2] ?? 20);
const SECONDS = Number(process.argv[3] ?? 30);
const THINK = Number(process.argv[4] ?? 0);
const BASE = process.argv[5] ?? 'http://localhost:8080';
const LOGIN = env.TERMFLOW_ADMIN_LOGIN ?? 'admin';
const PASSWORD = env.TERMFLOW_ADMIN_DEV_CURRENT_PASSWORD ?? env.TERMFLOW_ADMIN_PASSWORD;
const P = '/api/v1/projects/RMS';
const NAMES = [
  '전자결재번호',
  '요청일자',
  '접수일',
  '과제관리번호',
  '연구과제상태코드',
  '연구책임자구분',
  '비용금액',
  '사용여부',
];

class Session {
  cookies = new Map();
  csrf = '';
  async req(method, url, body, form = false) {
    const headers = { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
    if (method !== 'GET' && this.csrf) headers['x-xsrf-token'] = this.csrf;
    let payload;
    if (body !== undefined) {
      headers['content-type'] = form ? 'application/x-www-form-urlencoded' : 'application/json';
      payload = form ? new URLSearchParams(body).toString() : JSON.stringify(body);
    }
    const res = await fetch(BASE + url, { method, headers, body: payload });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    const text = await res.text();
    return { status: res.status, json: text && /^[[{]/.test(text) ? JSON.parse(text) : null };
  }
  async login() {
    this.csrf = (await this.req('GET', '/api/v1/auth/csrf')).json.token;
    const r = await this.req(
      'POST',
      '/api/v1/auth/login',
      { loginId: LOGIN, password: PASSWORD },
      true,
    );
    if (r.status !== 200) throw new Error(`로그인 실패 ${r.status}`);
    this.csrf = r.json.csrfToken;
  }
}

const samples = { autocomplete: [], tableDetail: [], tableList: [] };
const errors = { autocomplete: 0, tableDetail: 0, tableList: 0 };
async function timed(kind, fn) {
  const t = performance.now();
  const r = await fn();
  samples[kind].push(performance.now() - t);
  if (r.status >= 400) errors[kind]++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length
    ? Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] * 10) / 10
    : null;
};

const sessions = Array.from({ length: USERS }, () => new Session());
for (const s of sessions) await s.login();
const tables = (await sessions[0].req('GET', `${P}/tables?size=50`)).json.items.map(
  (t) => t.tableId,
);
const rp = (await sessions[0].req('GET', `${P}/biz-areas`)).json.find(
  (b) => b.bizCd === 'RP',
).bizAreaId;
const deadline = Date.now() + SECONDS * 1000;
let loops = 0;
await Promise.all(
  sessions.map(async (s, u) => {
    let i = u;
    while (Date.now() < deadline) {
      await timed('autocomplete', () =>
        s.req('POST', `${P}/autocomplete/columns`, {
          logicalNm: NAMES[i % NAMES.length],
          bizAreaId: rp,
        }),
      );
      if (THINK) await sleep(THINK);
      await timed('tableDetail', () => s.req('GET', `${P}/tables/${tables[i % tables.length]}`));
      if (THINK) await sleep(THINK);
      await timed('tableList', () => s.req('GET', `${P}/tables?size=20&page=${(i % 2) + 1}`));
      if (THINK) await sleep(THINK);
      i++;
      loops++;
    }
  }),
);
for (const s of sessions) await s.req('POST', '/api/v1/auth/logout');

const out = {
  users: USERS,
  seconds: SECONDS,
  thinkMs: THINK,
  loops,
  rps: Math.round((loops * 3) / SECONDS),
  ...Object.fromEntries(
    Object.entries(samples).map(([k, xs]) => [
      k,
      { n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), max: pct(xs, 100), errors: errors[k] },
    ]),
  ),
};
mkdirSync(path.join(ROOT, 'migration', 'work'), { recursive: true });
writeFileSync(
  path.join(ROOT, 'migration', 'work', `load-concurrency-${USERS}u-${THINK}ms.json`),
  JSON.stringify(out, null, 2),
);
console.log(JSON.stringify(out, null, 2));
