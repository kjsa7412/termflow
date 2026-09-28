/**
 * PoC 전용 NestJS 앱(T1.5 세션 로그인, T1.6 낙관적 잠금). 단계 2 이후로 흡수하지 않는다.
 * 확정할 설정(express-session + connect-pg-simple + csrf-csrf + bcrypt)만 PoC_결과에 옮긴다.
 */
import 'reflect-metadata';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Module,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Req,
  Res,
  UnauthorizedException,
  type INestApplication,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import bcrypt from 'bcrypt';
import connectPgSimple from 'connect-pg-simple';
import cookieParser from 'cookie-parser';
import { doubleCsrf } from 'csrf-csrf';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Request, Response } from 'express';
import session from 'express-session';
import type pg from 'pg';

declare module 'express-session' {
  interface SessionData {
    user?: { userId: number; loginId: string; userNm: string; isSysAdmin: boolean };
    anon?: boolean;
  }
}

const PG_POOL = Symbol('PG_POOL');
export const SESSION_COOKIE = 'tf.sid';
export const CSRF_COOKIE = 'XSRF-TOKEN';
export const CSRF_HEADER = 'x-xsrf-token';

function csrfUtilities(secret: string) {
  return doubleCsrf({
    getSecret: () => secret,
    // 세션 바인딩: 토큰 HMAC 메시지에 세션 ID를 넣는다 → 로그인(regenerate) 후 토큰 재발급 필요
    getSessionIdentifier: (req) => req.sessionID,
    cookieName: CSRF_COOKIE,
    // SPA가 쿠키를 읽어 헤더로 보낸다(double-submit) → httpOnly=false. dev는 http라 secure=false
    cookieOptions: { httpOnly: false, sameSite: 'lax', secure: false, path: '/' },
    getCsrfTokenFromRequest: (req) => req.get(CSRF_HEADER),
  });
}

type Csrf = ReturnType<typeof csrfUtilities>;
const CSRF = Symbol('CSRF');

function regenerate(req: Request): Promise<void> {
  return new Promise((resolve, reject) =>
    req.session.regenerate((e) => (e ? reject(e) : resolve())),
  );
}
function destroy(req: Request): Promise<void> {
  return new Promise((resolve, reject) => req.session.destroy((e) => (e ? reject(e) : resolve())));
}

@Controller('auth')
class AuthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(CSRF) private readonly csrf: Csrf,
  ) {}

  @Get('csrf')
  issue(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // saveUninitialized=false이면 익명 세션 ID가 요청마다 바뀐다 → 토큰 바인딩을 위해 세션을 저장시킨다
    req.session.anon = true;
    return { token: this.csrf.generateCsrfToken(req, res, { overwrite: true }) };
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: { loginId?: string; password?: string },
  ) {
    const { rows } = await this.pool.query<{
      user_id: number;
      login_id: string;
      user_nm: string;
      password_hash: string;
      is_sys_admin: boolean;
      pw_change_required: boolean;
    }>('select * from tf_user where login_id = $1 and is_active', [body.loginId ?? '']);
    const u = rows[0];
    if (!u || !(await bcrypt.compare(body.password ?? '', u.password_hash))) {
      throw new UnauthorizedException('아이디 또는 비밀번호가 올바르지 않습니다');
    }
    await regenerate(req); // 세션 고정 방지(§7.1)
    req.session.user = {
      userId: u.user_id,
      loginId: u.login_id,
      userNm: u.user_nm,
      isSysAdmin: u.is_sys_admin,
    };
    const csrfToken = this.csrf.generateCsrfToken(req, res, { overwrite: true });
    return {
      user: { userId: u.user_id, loginId: u.login_id, userNm: u.user_nm },
      mustChangePassword: u.pw_change_required,
      csrfToken,
    };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await destroy(req);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }
}

@Controller('me')
class MeController {
  @Get()
  me(@Req() req: Request) {
    if (!req.session.user) throw new UnauthorizedException();
    return req.session.user;
  }
}

interface ColumnCmd {
  columnId: number | null;
  logicalNm: string;
  physicalNm: string;
}
interface SaveBody {
  version: number;
  table: { tableLogicalNm: string };
  columns: ColumnCmd[];
}

class VersionConflict extends Error {}

@Controller('projects/:projectKey/tables')
class TableController {
  private readonly db: NodePgDatabase;
  constructor(@Inject(PG_POOL) pool: pg.Pool) {
    this.db = drizzle(pool);
  }

  @Put(':id')
  async save(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: SaveBody,
  ): Promise<{ version: number }> {
    const actor = req.session.user?.loginId;
    if (!actor) throw new UnauthorizedException();
    let saved: number;
    try {
      saved = await this.db.transaction(async (tx) => {
        const upd = await tx.execute<{ version: number }>(sql`
        UPDATE prj_table
           SET table_logical_nm = ${body.table.tableLogicalNm}, version = version + 1,
               updated_at = CURRENT_TIMESTAMP, updated_by = ${actor}, updated_ip = ${req.ip ?? null}
         WHERE table_id = ${id} AND version = ${body.version}
        RETURNING version`);
        if (upd.rowCount === 0) throw new VersionConflict(); // 0행 → 롤백(§8.1)
        // §8.2 순서만 바뀐 컬럼: col_seq만 갱신. uk(table_id,col_seq)는 DEFERRABLE → 커밋 시점 검사
        for (const [idx, c] of body.columns.entries()) {
          if (c.columnId == null) continue;
          await tx.execute(
            sql`UPDATE prj_column SET col_seq = ${idx + 1} WHERE column_id = ${c.columnId} AND table_id = ${id}`,
          );
        }
        return upd.rows[0]!.version;
      });
    } catch (e) {
      if (e instanceof VersionConflict) throw await this.conflict(id, body.version);
      throw e;
    }
    return { version: saved };
  }

  private async conflict(id: number, yourVersion: number): Promise<HttpException> {
    const t = await this.db.execute<{
      table_id: number;
      table_nm: string;
      table_logical_nm: string;
      version: number;
      updated_by: string;
      updated_at: string;
      user_nm: string | null;
    }>(sql`
      SELECT t.table_id, t.table_nm, t.table_logical_nm, t.version, t.updated_by,
             to_char(t.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS updated_at, u.user_nm
        FROM prj_table t LEFT JOIN tf_user u ON u.login_id = t.updated_by
       WHERE t.table_id = ${id}`);
    const cur = t.rows[0]!;
    const cols = await this.db.execute(
      sql`SELECT column_id, col_seq, logical_nm, physical_nm FROM prj_column WHERE table_id = ${id} ORDER BY col_seq`,
    );
    const savedBy = cur.user_nm ?? cur.updated_by;
    return new HttpException(
      {
        type: 'https://termflow.sjinc.co.kr/problems/version-conflict',
        title: '저장 충돌',
        status: 409,
        detail: `${savedBy}이(가) ${cur.updated_at.slice(11)}에 저장했습니다.`,
        code: 'E_VERSION_CONFLICT',
        yourVersion,
        currentVersion: cur.version,
        savedBy,
        savedAt: cur.updated_at,
        current: {
          table: {
            tableId: cur.table_id,
            tableNm: cur.table_nm,
            tableLogicalNm: cur.table_logical_nm,
            version: cur.version,
          },
          columns: cols.rows,
        },
      },
      409,
    );
  }
}

export interface PocApp {
  app: INestApplication;
  close: () => Promise<void>;
}

export async function createPocApp(pool: pg.Pool, secret: string): Promise<PocApp> {
  const csrf = csrfUtilities(secret);

  @Module({
    controllers: [AuthController, MeController, TableController],
    providers: [
      { provide: PG_POOL, useValue: pool },
      { provide: CSRF, useValue: csrf },
    ],
  })
  class PocModule {}

  const app = await NestFactory.create(PocModule, { logger: false });
  app.setGlobalPrefix('api/v1');
  const PgStore = connectPgSimple(session);
  const store = new PgStore({
    pool,
    tableName: 'tf_session',
    createTableIfMissing: false, // 부록 A가 tf_session을 만든다
    pruneSessionInterval: false, // 테스트에서는 타이머를 끈다(운영은 기본 15분)
  });
  app.use(cookieParser());
  app.use(
    session({
      name: SESSION_COOKIE,
      secret,
      store,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 60 * 60 * 1000 },
    }),
  );
  app.use(csrf.doubleCsrfProtection);
  await app.init();
  return {
    app,
    close: async () => {
      await app.close();
      store.close();
    },
  };
}

/** Set-Cookie를 모아 다음 요청의 Cookie 헤더를 만드는 최소 쿠키 저장소(앱 재생성 간 공유용). */
export class CookieJar {
  private readonly cookies = new Map<string, string>();
  store(setCookie: string[] | string | undefined): void {
    for (const line of Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []) {
      const [pair = ''] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  get(name: string): string | undefined {
    const v = this.cookies.get(name);
    return v === undefined ? undefined : decodeURIComponent(v);
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

/** 로그인용 사용자·프로젝트·테이블 시드(T1.5·T1.6). */
export async function seedPoc(pool: pg.Pool): Promise<{ tableId: number; columnIds: number[] }> {
  const hash = await bcrypt.hash('Passw0rd!', 10);
  await pool.query(
    `insert into tf_user(login_id,user_nm,password_hash,pw_change_required,created_by,updated_by)
     values ('hong','홍길동',$1,false,'SYSTEM','SYSTEM'), ('kim','김민수',$1,false,'SYSTEM','SYSTEM')`,
    [hash],
  );
  const p = await pool.query<{ project_id: number }>(
    `insert into tf_project(project_key,project_nm,created_by,updated_by) values ('RMS','연구관리','SYSTEM','SYSTEM') returning project_id`,
  );
  const pid = p.rows[0]!.project_id;
  const b = await pool.query<{ biz_area_id: number }>(
    `insert into prj_biz_area(project_id,biz_cd,biz_nm,created_by,updated_by) values ($1,'RP','연구과제','SYSTEM','SYSTEM') returning biz_area_id`,
    [pid],
  );
  const t = await pool.query<{ table_id: number }>(
    `insert into prj_table(project_id,biz_area_id,table_nm,table_logical_nm,created_by,updated_by)
     values ($1,$2,'RP_RSCH_PRJ_MST','연구과제마스터','hong','hong') returning table_id`,
    [pid, b.rows[0]!.biz_area_id],
  );
  const tableId = t.rows[0]!.table_id;
  const c = await pool.query<{ column_id: number }>(
    `insert into prj_column(project_id,table_id,col_seq,logical_nm,physical_nm,created_by,updated_by)
     values ($1,$2,1,'업무마스터ID','WRK_MAST_ID','hong','hong'), ($1,$2,2,'연구과제ID','RSCH_PRJ_ID','hong','hong'),
            ($1,$2,3,'과제명','PRJ_NM','hong','hong')
     returning column_id`,
    [pid, tableId],
  );
  return { tableId, columnIds: c.rows.map((r) => r.column_id) };
}
