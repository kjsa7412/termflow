import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { request, type APIRequestContext } from '@playwright/test';

/**
 * 데모 데이터(T12.6, CR-12 C3): 소개 사이트·설명서 그림용 **가상** 프로젝트 `EDU`(교육 운영 관리)를 API로 만든다.
 * 대상은 승계 없이 범용 기본 표준 STDV1만 있는 데모 인스턴스(1.2.0 이전 그림은 승계 1차 STDV1)(기본 `http://localhost:8095`, Linux 설치 검증 인스턴스). RMS·사내 이름을 쓰지 않는다.
 * 같은 인스턴스에 다시 돌려도 된다: 사용자·프로젝트가 있으면 건너뛴다. 데모 계정 비밀번호는 `e2e/.auth/demo-accounts.json`(gitignore).
 */
export const DEMO = 'EDU';
const AUTH_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.auth');
const ACCOUNTS = path.join(AUTH_DIR, 'demo-accounts.json');

type Accounts = Record<string, string>;
function loadAccounts(): Accounts {
  try {
    return JSON.parse(readFileSync(ACCOUNTS, 'utf8')) as Accounts;
  } catch {
    return {};
  }
}
function saveAccounts(a: Accounts): void {
  mkdirSync(AUTH_DIR, { recursive: true });
  writeFileSync(ACCOUNTS, JSON.stringify(a, null, 2), { mode: 0o600 });
}
/** 정책(8~64자, 2종 이상, 아이디 미포함)을 만족하는 데모 비밀번호. */
const newPassword = () => `Demo-${randomBytes(9).toString('base64url')}7`;

export class DemoApi {
  private constructor(
    readonly ctx: APIRequestContext,
    private csrf: string,
  ) {}

  /** 로그인(강제 변경이면 새 비밀번호로 바꾸고 기록). `initial`은 처음 로그인 때만 쓰는 비밀번호. */
  static async login(baseURL: string, loginId: string, initial?: string): Promise<DemoApi> {
    const accounts = loadAccounts();
    const ctx = await request.newContext({ baseURL });
    const t = (await (await ctx.get('/api/v1/auth/csrf')).json()) as { token: string };
    const tries = [accounts[loginId], initial].filter((p): p is string => Boolean(p));
    for (const password of tries) {
      const r = await ctx.post('/api/v1/auth/login', {
        headers: { 'X-XSRF-TOKEN': t.token },
        data: { loginId, password },
      });
      if (r.status() !== 200) continue;
      const body = (await r.json()) as { mustChangePassword: boolean; csrfToken: string };
      const api = new DemoApi(ctx, body.csrfToken);
      if (body.mustChangePassword) {
        const next = newPassword();
        const s = await api.send('put', '/api/v1/me/password', {
          currentPassword: password,
          newPassword: next,
        });
        if (s !== 204) throw new Error(`${loginId} 비밀번호 변경 실패 ${s}`);
        accounts[loginId] = next;
        saveAccounts(accounts);
      } else if (accounts[loginId] !== password) {
        accounts[loginId] = password;
        saveAccounts(accounts);
      }
      return api;
    }
    throw new Error(`${loginId} 로그인 실패 — DEMO_ADMIN_PASSWORD 또는 ${ACCOUNTS} 확인`);
  }

  async get<T>(p: string): Promise<T> {
    const r = await this.ctx.get(p);
    if (!r.ok()) throw new Error(`GET ${p} → ${r.status()}`);
    return (await r.json()) as T;
  }
  async send(method: 'post' | 'put' | 'delete', p: string, data?: unknown): Promise<number> {
    const r = await this.ctx[method](p, {
      headers: { 'X-XSRF-TOKEN': this.csrf },
      ...(data !== undefined ? { data } : {}),
    });
    return r.status();
  }
  async json<T>(method: 'post' | 'put', p: string, data: unknown): Promise<T> {
    const r = await this.ctx[method](p, { headers: { 'X-XSRF-TOKEN': this.csrf }, data });
    if (!r.ok()) throw new Error(`${method.toUpperCase()} ${p} → ${r.status()} ${await r.text()}`);
    return (await r.json()) as T;
  }
  async dispose(): Promise<void> {
    await this.ctx.dispose();
  }
}

// ── 가상 데이터 ──────────────────────────────────────────────────────────────────────
const USERS = [
  { loginId: 'kim.lead', userNm: '김지현', role: 'ADMIN' },
  { loginId: 'lee.dev', userNm: '이도윤', role: 'EDITOR' },
  { loginId: 'choi.dev', userNm: '최유진', role: 'EDITOR' },
  { loginId: 'park.view', userNm: '박서연', role: 'VIEWER' },
] as const;

const BIZ = [
  { bizCd: 'ED', bizNm: '교육', tablePrefix: 'ED_', sortNo: 1, description: '교육 과정·신청·평가' },
  { bizCd: 'AS', bizNm: '자산', tablePrefix: 'AS_', sortNo: 2, description: '교육 자산·장비 대여' },
  { bizCd: 'CM', bizNm: '공통', tablePrefix: 'CM_', sortNo: 9, description: '공통 코드·첨부' },
];
const CODES: Record<string, { codeCls: string; codeClsNm: string; codes: string[] }[]> = {
  ED: [
    { codeCls: '010', codeClsNm: '교육구분', codes: ['집합', '온라인', '혼합'] },
    { codeCls: '020', codeClsNm: '신청상태', codes: ['신청', '승인', '반려', '취소'] },
  ],
  AS: [
    { codeCls: '010', codeClsNm: '자산상태', codes: ['보유', '대여중', '수리', '폐기'] },
    { codeCls: '020', codeClsNm: '장비구분', codes: ['노트북', '프로젝터', '카메라'] },
  ],
};
/** 편집자가 인라인 등록하는 용어. approve = 승인까지(나머지는 승인 큐에 남는다). */
const INLINE = [
  { termKor: '과정', termPhysical: 'CRS', description: '교육 과정', approve: true },
  { termKor: '대여', termPhysical: 'RENT', description: '자산 대여', approve: true },
  { termKor: '반납', termPhysical: 'RTRN', description: '대여 자산 반납', approve: true },
  { termKor: '수료', termPhysical: 'CMPL', description: '교육 과정 수료', approve: false },
  { termKor: '강사', termPhysical: 'INSTR', description: '교육 강사', approve: false },
  { termKor: '교재', termPhysical: 'TXBK', description: '교육 교재', approve: false },
];
interface TableDef {
  biz: string;
  logical: string;
  description: string;
  pk: string[];
  cols: string[];
  final?: boolean;
}
export const TABLES: TableDef[] = [
  {
    biz: 'ED',
    logical: '교육과정마스터',
    description: '사내 교육 과정 기본 정보',
    pk: ['교육과정번호'],
    cols: [
      '교육과정번호',
      '교육과정명',
      '교육구분코드',
      '교육시작일자',
      '교육종료일자',
      '교육시간',
      '교육장소명',
      '담당자명',
      '사용여부',
    ],
    final: true,
  },
  {
    biz: 'ED',
    logical: '교육신청이력',
    description: '교육 과정 신청·승인 이력',
    pk: ['교육신청번호'],
    cols: [
      '교육신청번호',
      '교육과정번호',
      '사원번호',
      '부서코드',
      '신청일자',
      '신청상태코드',
      '승인일자',
      '반려사유',
      '취소여부',
    ],
  },
  {
    biz: 'ED',
    logical: '교육평가결과',
    description: '과정별 수강자 평가 결과',
    pk: ['교육과정번호', '사원번호'],
    cols: ['교육과정번호', '사원번호', '평가점수', '수료여부', '평가일자', '비고'],
  },
  {
    biz: 'AS',
    logical: '자산대여이력',
    description: '교육 자산 대여·반납 이력',
    pk: ['자산번호', '대여순서'],
    cols: [
      '자산번호',
      '대여순서',
      '대여시작일자',
      '반납예정일자',
      '반납일자',
      '대여사유',
      '자산상태코드',
    ],
    final: true,
  },
  {
    biz: 'AS',
    logical: '장비마스터',
    description: '교육 장비 기본 정보',
    pk: ['장비번호'],
    cols: ['장비번호', '장비명', '장비구분코드', '자산번호', '구매일자', '구매금액', '사용여부'],
  },
];

interface Applied {
  physicalNm: string;
  dataType: string | null;
  dataLength: number | null;
  dataScale: number | null;
  colComment: string | null;
  domainId: number | null;
  matchType: string;
}
interface AcItem {
  type: 'exact' | 'similar' | 'composed' | 'unregistered';
  input: string;
  applied: Applied | null;
  candidates?: (Applied & { logicalNm: string })[];
  codeCandidates?: (Applied & { codeClsId: number; codeClsNm: string; bizCd: string })[];
}
interface DefaultColItem {
  defaultColId: number;
  logicalNm: string;
  physicalNm: string;
  isPk: boolean;
  dataType: string;
  dataLength: number | null;
  dataScale: number | null;
  isNullable: boolean;
  defaultVal: string | null;
  colComment: string | null;
}

/** 데모 프로젝트를 만든다. 단계마다 이미 있는 것은 건너뛰어 중간에 멈춘 뒤 다시 돌려도 이어 간다. */
export async function seedDemo(baseURL: string, adminInitial: string | undefined): Promise<void> {
  const admin = await DemoApi.login(
    baseURL,
    process.env['DEMO_ADMIN_LOGIN'] ?? 'admin',
    adminInitial,
  );
  try {
    // DEMO_RESET=1: 데모 프로젝트를 지우고 처음부터(보관 → 삭제, 사용자는 남긴다)
    if (process.env['DEMO_RESET'] && (await admin.ctx.get(`/api/v1/projects/${DEMO}`)).ok()) {
      await admin.json('put', `/api/v1/admin/projects/${DEMO}/status`, { status: 'ARCHIVED' });
      const s = await admin.send('delete', `/api/v1/admin/projects/${DEMO}`, { confirmKey: DEMO });
      if (s !== 204) throw new Error(`데모 프로젝트 삭제 실패 ${s}`);
    }
    // 1) 사용자(가상 이름) — 초기 비밀번호를 정해 두고 각자 첫 로그인 때 바꾼다
    const accounts = loadAccounts();
    const ids: Record<string, number> = {};
    const list = await admin.get<{ items: { id: number; loginId: string }[] }>(
      '/api/v1/admin/users?size=100',
    );
    for (const u of USERS) {
      const found = list.items.find((x) => x.loginId === u.loginId);
      if (found) {
        ids[u.loginId] = found.id;
        continue;
      }
      const initial = newPassword();
      const r = await admin.json<{ user: { id: number } }>('post', '/api/v1/admin/users', {
        loginId: u.loginId,
        userNm: u.userNm,
        email: null,
        isSysAdmin: false,
        initialPassword: initial,
      });
      ids[u.loginId] = r.user.id;
      accounts[`${u.loginId}#initial`] = initial;
    }
    saveAccounts({ ...loadAccounts(), ...accounts });

    // 2) 프로젝트 — 표준은 범용 기본 표준 STDV1 템플릿(용어·도메인분류·도메인·기본컬럼), 업무구분·코드는 비우고 데모용으로 만든다
    const tpl = { source: 'TEMPLATE', sourceKey: 'STDV1' };
    if (!(await admin.ctx.get(`/api/v1/projects/${DEMO}`)).ok())
      await admin.json('post', '/api/v1/projects', {
        projectKey: DEMO,
        projectNm: '교육 운영 관리',
        description: '사내 교육 과정·신청·평가와 교육 자산 대여를 관리하는 가상 데모 프로젝트',
        defaultDialect: 'POSTGRESQL',
        imports: {
          bizAreas: { source: 'EMPTY' },
          terms: { ...tpl, approvedOnly: true },
          domainClasses: tpl,
          domains: tpl,
          codes: { source: 'EMPTY' },
          defaultColSets: tpl,
        },
        members: USERS.map((u) => ({ userId: ids[u.loginId], role: u.role })),
      });
    const P = `/api/v1/projects/${DEMO}`;

    // 3) 업무구분·코드(있는 것은 건너뛴다)
    const biz: Record<string, number> = {};
    const bizNow = await admin.get<{ bizAreaId: number; bizCd: string }[]>(`${P}/biz-areas`);
    for (const b of BIZ) {
      const have = bizNow.find((x) => x.bizCd === b.bizCd);
      biz[b.bizCd] = have
        ? have.bizAreaId
        : (await admin.json<{ bizAreaId: number }>('post', `${P}/biz-areas`, { ...b, useYn: true }))
            .bizAreaId;
    }
    for (const [bizCd, classes] of Object.entries(CODES)) {
      const clsNow = await admin.get<{ items: { codeCls: string }[] }>(
        `${P}/standards/code-classes?bizAreaId=${biz[bizCd]}&size=100`,
      );
      for (const c of classes) {
        if (clsNow.items.some((x) => x.codeCls === c.codeCls)) continue;
        const cls = await admin.json<{ codeClsId: number }>('post', `${P}/standards/code-classes`, {
          bizAreaId: biz[bizCd],
          codeCls: c.codeCls,
          codeClsNm: c.codeClsNm,
          description: null,
        });
        for (const [i, nm] of c.codes.entries()) {
          await admin.json('post', `${P}/standards/code-classes/${cls.codeClsId}/codes`, {
            code: String(i + 1).padStart(2, '0'),
            codeNm: nm,
            sortOrder: i + 1,
            isActive: true,
          });
        }
      }
    }

    // 4) 편집자(이도윤)가 미등록 용어를 인라인 등록 → 관리자가 일부 승인
    const editor = await DemoApi.login(baseURL, 'lee.dev', loadAccounts()['lee.dev#initial']);
    try {
      for (const t of INLINE) {
        const r = await editor.json<{ termId: number; status: string }>(
          'post',
          `${P}/standards/terms/inline`,
          { termKor: t.termKor, termPhysical: t.termPhysical, description: t.description },
        );
        if (t.approve && r.status === 'PENDING')
          await admin.json('post', `${P}/standards/approvals/${r.termId}/approve`, {});
      }

      // 5) 테이블 — 편집기와 같은 자동완성 결과(applied)로 컬럼을 채우고 기본컬럼 세트를 붙인다
      const sets = await editor.get<{ isDefault: boolean; columns: DefaultColItem[] }[]>(
        `${P}/standards/default-column-sets`,
      );
      const defaults = (sets.find((s) => s.isDefault) ?? sets[0])?.columns ?? [];
      for (const t of TABLES) {
        const bizAreaId = biz[t.biz]!;
        const name = await editor.json<{ tableNm: string }>('post', `${P}/tables/suggest-name`, {
          logicalNm: t.logical,
          bizAreaId,
        });
        const have = await editor.get<{ items: { tableNm: string }[] }>(
          `${P}/tables?q=${encodeURIComponent(name.tableNm)}&size=20`,
        );
        if (have.items.some((x) => x.tableNm === name.tableNm)) continue;
        const ac = await editor.json<{ items: AcItem[] }>(
          'post',
          `${P}/autocomplete/columns/batch`,
          {
            logicalNms: t.cols,
            bizAreaId,
          },
        );
        const columns = ac.items.map((it) => {
          const code = it.input.endsWith('코드') ? it.codeCandidates?.[0] : undefined;
          const a = code ?? it.applied ?? it.candidates?.[0];
          if (!a || !a.physicalNm || a.physicalNm.includes('?') || !a.dataType)
            throw new Error(
              `${t.logical}.${it.input}: 자동완성 결과를 그대로 쓸 수 없음(${it.type}, ${a?.physicalNm ?? '물리명 없음'}, 타입 ${a?.dataType ?? '없음'}) — 컬럼 이름을 바꾸세요`,
            );
          return {
            columnId: null,
            logicalNm:
              it.type === 'similar' && !it.applied
                ? (it.candidates?.[0]?.logicalNm ?? it.input)
                : it.input,
            physicalNm: a.physicalNm,
            isPk: t.pk.includes(it.input),
            dataType: a.dataType,
            dataLength: a.dataLength,
            dataScale: a.dataScale,
            isNullable: !t.pk.includes(it.input),
            // 기본값은 값만(DDL 엔진이 문자형을 따옴표로 감싼다)
            defaultVal: it.input.endsWith('여부') ? 'N' : null,
            colComment: a.colComment ?? it.input,
            domainId: a.domainId ?? null,
            codeClsId: code ? code.codeClsId : null,
            defaultColId: null as number | null,
            matchType: code ? 'CODE' : (a.matchType ?? 'MANUAL'),
          };
        });
        for (const d of defaults) {
          columns.push({
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
          });
        }
        const saved = await editor.json<{ tableId: number; version: number }>(
          'post',
          `${P}/tables`,
          {
            table: {
              bizAreaId,
              tableNm: name.tableNm,
              tableLogicalNm: t.logical,
              description: t.description,
            },
            columns,
          },
        );
        if (t.final)
          await editor.json('put', `${P}/tables/${saved.tableId}/status`, {
            status: 'FINAL',
            version: saved.version,
            note: '설계 검토 완료',
          });
      }
    } finally {
      await editor.dispose();
    }
  } finally {
    await admin.dispose();
  }
}

/** 데모 관리자 세션(storageState) 파일을 만든다. */
export async function adminState(baseURL: string, file: string): Promise<void> {
  const admin = await DemoApi.login(baseURL, process.env['DEMO_ADMIN_LOGIN'] ?? 'admin');
  try {
    await admin.ctx.storageState({ path: file });
  } finally {
    await admin.dispose();
  }
}

export const hasAccounts = () => existsSync(ACCOUNTS);
