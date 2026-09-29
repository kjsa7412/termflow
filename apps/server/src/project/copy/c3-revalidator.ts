import { sql } from 'drizzle-orm';
import type { TypeSource } from '@termflow/shared';
import { calculateDomain, type L1Result } from '../../autocomplete/domain-calculator.js';
import { loadL1Snapshot } from '../../autocomplete/l1-snapshot.js';
import type { Db } from '../../db/client.js';

/**
 * C3 재검증기(설계서 §4.3 C3·§4.4 단계 9, T5.3). 도메인은 용어·도메인분류에 의존하므로 세 항목의 원본이 다르면
 * 복사 후 도메인 전건을 L1(§5.2, `calculateDomain` — 러너 R5·R15와 같은 구현)으로 다시 계산한다.
 *
 * 판정(CR-04 C2): **새 프로젝트의 용어·분류로 계산한 결과**와 **도메인 원본 프로젝트의 용어·분류로 계산한 결과**를
 * 비교해 달라진 행만 표시한다. 저장값과 비교하면 원본 자체의 기존 불일치(STDV1 비검토 29건 등)까지 섞여
 * "같은 내용인데 원본만 다른" 경우에도 경고가 난다. 원본이 같으면(needsC3=false) 호출하지 않는다.
 *
 * 반영: `UPDATE std_domain … FROM unnest(ids, notes)` 1문장(review_yn=TRUE, review_note = 'C3: …' + 기존 메모).
 * 생성 트랜잭션의 일부라 updated_* 감사 컬럼은 건드리지 않는다(사본의 created_at = updated_at 유지, §4.9 차이 비교 근거).
 */
export interface C3Sample {
  domainId: number;
  logicalNm: string;
  reason: string;
}

export interface C3Result {
  checked: number;
  flagged: number;
  samples: C3Sample[];
}

type Q = Pick<Db, 'select' | 'execute'>;

const typeKey = (r: L1Result) => r.typeText ?? '(없음)';

/** 두 L1 결과가 다르면 사유(없으면 null). MANUAL 도메인은 타입을 비교하지 않는다(수기 타입 유지). */
export function c3Reason(next: L1Result, base: L1Result, typeSource: TypeSource): string | null {
  const baseMissing = new Set(base.notFound);
  const newlyMissing = [...new Set(next.notFound.filter((p) => !baseMissing.has(p)))];
  if (newlyMissing.length > 0) return `미등록 조각: ${newlyMissing.join(', ')}`;
  if (next.physicalNm !== base.physicalNm) return `물리명 ${base.physicalNm} → ${next.physicalNm}`;
  if (next.suffix !== base.suffix)
    return `접미어 ${base.suffix ?? '없음'} → ${next.suffix ?? '없음'}`;
  if (typeSource === 'AUTO' && typeKey(next) !== typeKey(base)) {
    return next.colType === null
      ? `접미어 ${next.suffix ?? ''} 도메인분류 없음(타입 ${typeKey(base)} → 없음)`
      : `타입 ${typeKey(base)} → ${typeKey(next)}`;
  }
  return null;
}

export async function revalidateC3(
  q: Q,
  newProjectId: number,
  domainSourceProjectId: number,
  sampleMax = 5,
): Promise<C3Result> {
  const [nextSnap, baseSnap] = await Promise.all([
    loadL1Snapshot(q, newProjectId),
    loadL1Snapshot(q, domainSourceProjectId),
  ]);
  const { rows } = await q.execute(
    sql`select domain_id, logical_nm, type_source, nm1, nm2, nm3, nm4, nm5, nm6, nm7
          from std_domain where project_id = ${newProjectId} order by domain_id`,
  );
  const ids: number[] = [];
  const notes: string[] = [];
  const samples: C3Sample[] = [];
  for (const r of rows as {
    domain_id: number;
    logical_nm: string;
    type_source: TypeSource;
    nm1: string;
    nm2: string | null;
    nm3: string | null;
    nm4: string | null;
    nm5: string | null;
    nm6: string | null;
    nm7: string | null;
  }[]) {
    const input = {
      parts: [r.nm1, r.nm2, r.nm3, r.nm4, r.nm5, r.nm6, r.nm7],
      typeSource: r.type_source,
    };
    const reason = c3Reason(
      calculateDomain(input, nextSnap),
      calculateDomain(input, baseSnap),
      r.type_source,
    );
    if (reason === null) continue;
    ids.push(r.domain_id);
    notes.push(`C3: 복사 후 L1 불일치(${reason})`);
    if (samples.length < sampleMax)
      samples.push({ domainId: r.domain_id, logicalNm: r.logical_nm, reason });
  }
  if (ids.length > 0) {
    await q.execute(
      sql`update std_domain d
             set review_yn = true,
                 review_note = left(u.note || coalesce(' / ' || d.review_note, ''), 500)
            from unnest(${sql.param(ids)}::int[], ${sql.param(notes)}::text[]) as u(id, note)
           where d.domain_id = u.id and d.project_id = ${newProjectId}`,
    );
  }
  return { checked: rows.length, flagged: ids.length, samples };
}
