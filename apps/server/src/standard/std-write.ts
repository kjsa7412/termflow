import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { API_ERROR_CODES, type ProjectKind, type ProjectStatus } from '@termflow/shared';
import { TermCacheRegistry } from '../autocomplete/term-cache-registry.js';
import { ConflictProblem } from '../common/problem/problem.exception.js';
import type { ProjectCtx } from '../common/project-context.js';
import type { Db } from '../db/client.js';
import { DRIZZLE } from '../db/db.module.js';
import { tfProject } from '../db/schema.js';

/** 트랜잭션 실행자(db.transaction 콜백 인자). */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * 표준 사전 쓰기 공통 경로(T6.1, `standard/README.md`). 모든 표준 쓰기 서비스는 이 클래스로만 쓴다.
 *  1. 쓰기 가능 검사: 보관 프로젝트 409, 템플릿은 시스템 관리자만(§4.1·§4.6) — 가드와 이중 검사(서비스 재확인, §12.2)
 *  2. `db.transaction` 안에서 행 쓰기 + `writeStdAudit`(같은 트랜잭션)
 *  3. 커밋 후 `TermCacheRegistry.invalidate(projectId)`(§5.1, 단계 9 전까지 no-op). 롤백이면 호출하지 않는다.
 */
@Injectable()
export class StdWriter {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: TermCacheRegistry,
  ) {}

  /** 요청 컨텍스트(가드 결과) 기준 쓰기 가능 검사. */
  assertWritable(ctx: Pick<ProjectCtx, 'status' | 'kind' | 'sysAdmin'>): void {
    assertWritableState(ctx.status, ctx.kind, ctx.sysAdmin);
  }

  /** 가드 시점 이후 상태가 바뀌었을 수 있는 긴 작업(일괄 등록 적용)은 DB에서 다시 읽어 검사한다. */
  async assertWritableNow(projectId: number, sysAdmin: boolean): Promise<void> {
    const [p] = await this.db
      .select({ status: tfProject.status, kind: tfProject.kind })
      .from(tfProject)
      .where(eq(tfProject.projectId, projectId));
    if (!p) throw new ConflictProblem('E_PROJECT_READONLY', '프로젝트가 삭제되었습니다');
    assertWritableState(p.status as ProjectStatus, p.kind as ProjectKind, sysAdmin);
  }

  async write<T>(ctx: ProjectCtx, fn: (tx: Tx) => Promise<T>): Promise<T> {
    this.assertWritable(ctx);
    const r = await this.db.transaction(fn);
    this.cache.invalidate(ctx.projectId);
    return r;
  }
}

export function assertWritableState(
  status: ProjectStatus,
  kind: ProjectKind,
  sysAdmin: boolean,
): void {
  if (status === 'ARCHIVED' || (kind === 'TEMPLATE' && !sysAdmin)) {
    throw new ConflictProblem('E_PROJECT_READONLY', API_ERROR_CODES.E_PROJECT_READONLY);
  }
}
