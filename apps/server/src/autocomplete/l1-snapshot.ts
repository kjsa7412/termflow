import { and, eq, ne } from 'drizzle-orm';
import type { StdType } from '@termflow/shared';
import type { Db } from '../db/client.js';
import { stdDomainCls, stdTerm } from '../db/schema.js';
import type { DomainClsEntry, L1Snapshot, TermEntry } from './domain-calculator.js';

/** Db 또는 트랜잭션 — select만 쓴다. */
export type SelectExecutor = Pick<Db, 'select'>;

/**
 * 프로젝트 1개의 L1 입력 스냅샷(용어 → 물리약어, 접미어 → 타입)을 메모리에 적재한다(설계서 §5.2).
 * 승계 러너 DOMAIN step(§11.1 "L1은 STDV1 캐시로 재계산" — CR-16 이후 승계 템플릿 RETAILV1)과 복사 엔진 C3 재검증(§4.4 단계 9)이 같이 쓴다.
 * 단계 9 TermCache도 같은 인터페이스(L1Snapshot)를 제공한다.
 */
export async function loadL1Snapshot(q: SelectExecutor, projectId: number): Promise<L1Snapshot> {
  const terms = await q
    .select({ kor: stdTerm.termKor, physical: stdTerm.termPhysical, id: stdTerm.termId })
    .from(stdTerm)
    // 반려(REJECTED) 용어는 미등록과 같다(§5.1 자동완성 대상 = APPROVED·PENDING)
    .where(and(eq(stdTerm.projectId, projectId), ne(stdTerm.status, 'REJECTED')));
  const cls = await q
    .select({
      id: stdDomainCls.domainClsId,
      suffix: stdDomainCls.suffix,
      colType: stdDomainCls.colType,
      colLength: stdDomainCls.colLength,
      colScale: stdDomainCls.colScale,
    })
    .from(stdDomainCls)
    .where(eq(stdDomainCls.projectId, projectId));
  return {
    termByKor: new Map<string, TermEntry>(
      terms.map((t) => [t.kor, { physical: t.physical, termId: t.id }]),
    ),
    clsBySuffix: new Map<string, DomainClsEntry>(
      cls.map((c) => [
        c.suffix,
        {
          domainClsId: c.id,
          colType: c.colType as StdType,
          colLength: c.colLength,
          colScale: c.colScale,
        },
      ]),
    ),
  };
}
