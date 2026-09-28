import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { count } from 'drizzle-orm';
import { SYSTEM_AUDIT } from '../common/audit/audit.js';
import type { Env } from '../config/env.schema.js';
import { insertAudited } from '../db/audit.js';
import type { Db } from '../db/client.js';
import { DRIZZLE } from '../db/db.module.js';
import { tfUser } from '../db/schema.js';
import { hashPassword } from './password.js';

export const BOOTSTRAP_ADMIN_NM = '시스템 관리자';

/**
 * 초기 관리자 부트스트랩(T4.3, 설계서 §7.5): `tf_user` 0건이면 `TERMFLOW_ADMIN_LOGIN`으로 시스템 관리자를 만든다.
 * `pw_change_required=TRUE`, created_by 'SYSTEM', 프로젝트 멤버십 없음. 로그에는 로그인 ID만 1줄(비밀번호 미출력).
 * prod에서 `TERMFLOW_ADMIN_PASSWORD`가 없으면 환경 변수 검증(env.schema.ts)이 기동을 막는다.
 * 동시 기동은 login_id 유니크 + ON CONFLICT DO NOTHING으로 1건만 남는다.
 */
export async function ensureInitialAdmin(
  db: Db,
  env: Pick<Env, 'TERMFLOW_ADMIN_LOGIN' | 'TERMFLOW_ADMIN_PASSWORD'>,
  log: (msg: string) => void,
): Promise<boolean> {
  const [r] = await db.select({ n: count() }).from(tfUser);
  if ((r?.n ?? 0) > 0) return false;
  const inserted = await insertAudited(
    db,
    tfUser,
    {
      loginId: env.TERMFLOW_ADMIN_LOGIN,
      userNm: BOOTSTRAP_ADMIN_NM,
      passwordHash: await hashPassword(env.TERMFLOW_ADMIN_PASSWORD),
      isSysAdmin: true,
      isActive: true,
      pwChangeRequired: true,
    },
    SYSTEM_AUDIT,
  )
    .onConflictDoNothing()
    .returning({ id: tfUser.userId });
  if (inserted.length > 0) log(`초기 관리자 생성: ${env.TERMFLOW_ADMIN_LOGIN}`);
  return inserted.length > 0;
}

@Injectable()
export class BootstrapAdmin implements OnApplicationBootstrap {
  private readonly logger = new Logger('Bootstrap');

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await ensureInitialAdmin(
      this.db,
      {
        TERMFLOW_ADMIN_LOGIN: this.config.get('TERMFLOW_ADMIN_LOGIN', { infer: true }),
        TERMFLOW_ADMIN_PASSWORD: this.config.get('TERMFLOW_ADMIN_PASSWORD', { infer: true }),
      },
      (m) => this.logger.log(m),
    );
  }
}
