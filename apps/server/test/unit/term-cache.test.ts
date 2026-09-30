import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TermCacheCore } from '../../src/autocomplete/term-cache-registry.js';
import type { TermSnapshot } from '../../src/autocomplete/term-snapshot.js';
import { makeSnapshot } from './autocomplete-fixtures.js';

// T9.1 TermCacheRegistry(설계서 §5.1): 지연 로드·동시 적재 병합·LRU·유휴 정리·무효화(코얼레싱)·cacheVersion
function harness(opts: { maxProjects?: number; delayMs?: number } = {}) {
  let now = 1_000_000;
  const calls: number[] = [];
  const core = new TermCacheCore(
    async (pid) => {
      calls.push(pid);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      return makeSnapshot({}, pid);
    },
    { maxProjects: opts.maxProjects ?? 20, now: () => now },
  );
  return {
    core,
    calls,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

describe('TermCacheCore', () => {
  it('지연 로드: 첫 get에서만 적재(loaded=true), 두 번째는 적중', async () => {
    const h = harness();
    expect(h.core.has(1)).toBe(false);
    const a = await h.core.get(1);
    const b = await h.core.get(1);
    expect(h.calls).toEqual([1]);
    expect([a.loaded, b.loaded]).toEqual([true, false]);
    expect(a.snapshot).toBe(b.snapshot);
    expect(a.cacheVersion).toBe(1);
    expect(h.core.stats).toMatchObject({ loads: 1, hits: 1 });
  });

  it('동시 요청 10건 → 적재 1회(같은 Promise 공유)', async () => {
    const h = harness({ delayMs: 20 });
    const all = await Promise.all(Array.from({ length: 10 }, () => h.core.get(7)));
    expect(h.calls).toEqual([7]);
    expect(new Set(all.map((x) => x.snapshot)).size).toBe(1);
  });

  it('LRU 축출: 상한 2 — 최근 사용을 남기고 가장 오래 안 쓴 프로젝트를 내보낸다', async () => {
    const h = harness({ maxProjects: 2 });
    await h.core.get(1);
    await h.core.get(2);
    await h.core.get(1); // 1을 최근 사용으로
    await h.core.get(3); // 2 축출
    expect(h.core.list().map((x) => x.projectId)).toEqual([1, 3]);
    expect(h.core.stats.evictions).toBe(1);
    await h.core.get(2);
    expect(h.calls).toEqual([1, 2, 3, 2]);
  });

  it('무효화 후 재적재 + cacheVersion 증가, 다른 프로젝트 캐시는 그대로(CR-01-2)', async () => {
    const h = harness();
    const a1 = await h.core.get(1);
    const b1 = await h.core.get(2);
    h.core.invalidate(1);
    expect(h.core.has(1)).toBe(false);
    expect(h.core.has(2)).toBe(true);
    const a2 = await h.core.get(1);
    const b2 = await h.core.get(2);
    expect(a2.loaded).toBe(true);
    expect(a2.cacheVersion).toBe(a1.cacheVersion + 1);
    expect(b2.snapshot).toBe(b1.snapshot);
    expect(h.core.recentInvalidations()).toEqual([1]);
  });

  it('적재 중 무효화: 기다리던 요청은 잡은 스냅샷을 받고(진행 중 일관성), 결과는 저장하지 않아 다음 요청이 새로 적재', async () => {
    const h = harness({ delayMs: 20 });
    const p = h.core.get(1);
    h.core.invalidate(1);
    const first = await p;
    expect(first.loaded).toBe(true);
    expect(h.core.has(1)).toBe(false);
    const second = await h.core.get(1);
    expect(second.loaded).toBe(true);
    expect(h.calls).toEqual([1, 1]);
  });

  it('100ms 코얼레싱: 연속 무효화 5건 → 이벤트 1건, 재적재는 다음 요청 1회', async () => {
    const h = harness();
    await h.core.get(1);
    for (let i = 0; i < 5; i++) {
      h.core.invalidate(1);
      h.tick(10);
    }
    h.tick(200);
    h.core.invalidate(1);
    expect(h.core.stats).toMatchObject({ invalidateCalls: 6, invalidateEvents: 2 });
    await h.core.get(1);
    expect(h.calls).toEqual([1, 1]);
  });

  it('유휴 60분 초과 항목 정리(5분 주기 sweep)', async () => {
    const h = harness();
    await h.core.get(1);
    h.tick(30 * 60_000);
    await h.core.get(2);
    h.tick(31 * 60_000);
    expect(h.core.sweep()).toEqual([1]);
    expect(h.core.list().map((x) => x.projectId)).toEqual([2]);
  });

  it('reload = 무효화 + 즉시 적재', async () => {
    const h = harness();
    await h.core.get(1);
    const r = await h.core.reload(1);
    expect(r).toMatchObject({ loaded: true, cacheVersion: 2 });
    expect(h.core.list()[0]).toMatchObject({ projectId: 1, cacheVersion: 2 });
    expect(h.core.list()[0]!.counts.terms).toBeGreaterThan(10);
  });

  it('적재 실패는 호출자에게 전파되고 캐시에 남지 않는다(다음 요청 재시도)', async () => {
    let fail = true;
    const core = new TermCacheCore(async (pid) => {
      if (fail) throw new Error('db down');
      return makeSnapshot({}, pid) as TermSnapshot;
    });
    await expect(core.get(1)).rejects.toThrow('db down');
    fail = false;
    await expect(core.get(1)).resolves.toMatchObject({ loaded: true, cacheVersion: 1 });
  });
});

/**
 * 표준 사전·업무구분 쓰기 서비스 전부가 커밋 후 무효화를 부르는지(T9.1 DoD) — 정적 검사:
 *  - `src/standard/**` 서비스는 트랜잭션을 직접 열지 않고 `StdWriter.write`(커밋 후 invalidate)만 쓴다.
 *  - `src/project/biz-area.service.ts`는 트랜잭션 수 = invalidate 호출 수.
 * 새 쓰기 서비스가 이 규칙을 어기면 실패한다(런타임 호출 검사는 test:db standard·biz-area·import·autocomplete).
 */
describe('무효화 호출 규약(정적 검사)', () => {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );
  const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

  it('표준 사전 서비스는 StdWriter.write로만 쓴다', () => {
    const files = walk(path.join(SRC, 'standard')).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('std-write.ts'),
    );
    const writers: string[] = [];
    for (const f of files) {
      const t = readFileSync(f, 'utf8');
      expect(
        count(t, /\bdb\.transaction\(/g),
        `${path.basename(f)}: db.transaction 직접 사용`,
      ).toBe(0);
      if (/\.write\(ctx/.test(t)) writers.push(path.basename(f));
    }
    expect(writers.sort()).toEqual(
      expect.arrayContaining([
        'approval.service.ts',
        'code.service.ts',
        'default-col.service.ts',
        'domain-cls.service.ts',
        'domain.service.ts',
        'import.service.ts',
        'term.service.ts',
      ]),
    );
    const w = readFileSync(path.join(SRC, 'standard', 'std-write.ts'), 'utf8');
    expect(w).toMatch(
      /await this\.db\.transaction\(fn\);\s*this\.cache\.invalidate\(ctx\.projectId\);/,
    );
  });

  it('업무구분 서비스: 쓰기 트랜잭션마다 커밋 후 invalidate', () => {
    const t = readFileSync(path.join(SRC, 'project', 'biz-area.service.ts'), 'utf8');
    const tx = count(t, /this\.db\.transaction\(/g);
    expect(tx).toBeGreaterThanOrEqual(3);
    expect(count(t, /this\.cache\.invalidate\(ctx\.projectId\)/g)).toBe(tx);
  });
});
