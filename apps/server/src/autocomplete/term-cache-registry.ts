import { Inject, Injectable, Logger, Optional, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import type { Db } from '../db/client.js';
import { DRIZZLE } from '../db/db.module.js';
import { loadTermSnapshot, type TermSnapshot } from './term-snapshot.js';

/**
 * 프로젝트별 자동완성 캐시 레지스트리(설계서 §5.1, CR-01 3절, T9.1).
 *  - 지연 로드: 프로젝트의 첫 자동완성·검증·물리명 제안 요청 때 적재. 동시 요청은 같은 Promise를 공유(중복 적재 1회).
 *  - LRU: 최대 `TERMFLOW_CACHE_MAX_PROJECTS`(기본 20)개, 유휴 60분 초과는 5분 주기로 정리.
 *  - 무효화: 표준 사전·업무구분 쓰기 **커밋 후** `invalidate(projectId)` — 항목·진행 중 적재를 즉시 폐기해 다음 요청이
 *    새 스냅샷을 보게 한다(인라인 등록 직후 재시도의 정확성, G2). 100ms 안의 연속 무효화는 무효화 이벤트 1건으로
 *    합치고(코얼레싱), 재적재는 다음 요청 1회로 모인다(CR-08 C1).
 *  - 일관성: 진행 중 요청은 잡아 둔 스냅샷을 끝까지 쓴다(불변 객체). 응답 `cacheVersion` = 프로젝트별 적재 횟수(증가 정수).
 * 다른 프로젝트 캐시는 무효화에 영향받지 않는다(CR-01-2).
 */
export interface CacheEntryInfo {
  projectId: number;
  cacheVersion: number;
  counts: TermSnapshot['counts'];
  loadMs: number;
  loadedAt: string;
  lastUsedAt: string;
}

export interface CachedSnapshot {
  snapshot: TermSnapshot;
  cacheVersion: number;
  /** 이번 요청이 적재를 기다렸는지(첫 적재 소요 분리 보고, §5.8). */
  loaded: boolean;
  loadMs: number;
}

interface Entry {
  snapshot: TermSnapshot;
  version: number;
  loadMs: number;
  loadedAt: number;
  lastUsedAt: number;
}

export interface CacheOptions {
  maxProjects: number;
  idleMs: number;
  sweepMs: number;
  coalesceMs: number;
  now: () => number;
}

export const CACHE_DEFAULTS: CacheOptions = {
  maxProjects: 20,
  idleMs: 60 * 60_000,
  sweepMs: 5 * 60_000,
  coalesceMs: 100,
  now: () => Date.now(),
};

/** Nest 비의존 코어(단위 테스트: 가짜 로더·시계). */
export class TermCacheCore {
  private readonly entries = new Map<number, Entry>();
  private readonly loading = new Map<number, Promise<Entry>>();
  /** 프로젝트별 세대(무효화마다 +1) — 적재 중 무효화되면 결과를 저장하지 않는다. */
  private readonly gen = new Map<number, number>();
  private readonly versions = new Map<number, number>();
  private readonly lastInvalidateAt = new Map<number, number>();
  private readonly invalidated: number[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  readonly stats = { loads: 0, hits: 0, evictions: 0, invalidateCalls: 0, invalidateEvents: 0 };
  readonly opts: CacheOptions;

  constructor(
    private readonly loader: (projectId: number) => Promise<TermSnapshot>,
    opts: Partial<CacheOptions> = {},
  ) {
    this.opts = { ...CACHE_DEFAULTS, ...opts };
  }

  /** 스냅샷(없으면 적재). */
  async get(projectId: number): Promise<CachedSnapshot> {
    const e = this.entries.get(projectId);
    if (e) {
      e.lastUsedAt = this.opts.now();
      // LRU: 최근 사용을 맨 뒤로
      this.entries.delete(projectId);
      this.entries.set(projectId, e);
      this.stats.hits++;
      return { snapshot: e.snapshot, cacheVersion: e.version, loaded: false, loadMs: 0 };
    }
    const entry = await this.load(projectId);
    return {
      snapshot: entry.snapshot,
      cacheVersion: entry.version,
      loaded: true,
      loadMs: entry.loadMs,
    };
  }

  private load(projectId: number): Promise<Entry> {
    const pending = this.loading.get(projectId);
    if (pending) return pending;
    const g = this.gen.get(projectId) ?? 0;
    const t0 = performance.now();
    const p = (async () => {
      const snapshot = await this.loader(projectId);
      const version = (this.versions.get(projectId) ?? 0) + 1;
      const now = this.opts.now();
      const entry: Entry = {
        snapshot,
        version,
        loadMs: Math.round((performance.now() - t0) * 10) / 10,
        loadedAt: now,
        lastUsedAt: now,
      };
      this.stats.loads++;
      // 적재 중 무효화되지 않았을 때만 저장(무효화됐으면 기다린 요청에만 돌려주고 다음 요청은 다시 적재)
      if ((this.gen.get(projectId) ?? 0) === g) {
        this.versions.set(projectId, version);
        this.entries.set(projectId, entry);
        this.evictOverflow();
      }
      return entry;
    })();
    this.loading.set(projectId, p);
    const clear = () => {
      if (this.loading.get(projectId) === p) this.loading.delete(projectId);
    };
    p.then(clear, clear);
    return p;
  }

  private evictOverflow(): void {
    while (this.entries.size > this.opts.maxProjects) {
      const oldest = this.entries.keys().next().value as number;
      this.entries.delete(oldest);
      this.stats.evictions++;
    }
  }

  /** 커밋 후 호출(롤백이면 호출하지 않는다). */
  invalidate(projectId: number): void {
    this.stats.invalidateCalls++;
    const now = this.opts.now();
    const last = this.lastInvalidateAt.get(projectId);
    if (last === undefined || now - last >= this.opts.coalesceMs) this.stats.invalidateEvents++;
    this.lastInvalidateAt.set(projectId, now);
    this.gen.set(projectId, (this.gen.get(projectId) ?? 0) + 1);
    this.entries.delete(projectId);
    this.loading.delete(projectId);
    this.invalidated.push(projectId);
    if (this.invalidated.length > 100) this.invalidated.shift();
  }

  /** 최근 무효화 요청(가장 최근이 끝) — 표준 쓰기 서비스의 호출 검사용. */
  recentInvalidations(): readonly number[] {
    return this.invalidated;
  }

  /** 유휴 항목 정리(5분 주기). 정리한 프로젝트 ID. */
  sweep(): number[] {
    const limit = this.opts.now() - this.opts.idleMs;
    const out: number[] = [];
    for (const [id, e] of this.entries) {
      if (e.lastUsedAt < limit) {
        this.entries.delete(id);
        out.push(id);
      }
    }
    return out;
  }

  startSweeper(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), this.opts.sweepMs);
    this.timer.unref?.();
  }

  stopSweeper(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  has(projectId: number): boolean {
    return this.entries.has(projectId);
  }

  /** 적재 목록(LRU 순서: 오래 안 쓴 것부터). */
  list(): CacheEntryInfo[] {
    const iso = (ms: number) => new Date(ms).toISOString();
    return [...this.entries].map(([projectId, e]) => ({
      projectId,
      cacheVersion: e.version,
      counts: e.snapshot.counts,
      loadMs: e.loadMs,
      loadedAt: iso(e.loadedAt),
      lastUsedAt: iso(e.lastUsedAt),
    }));
  }

  /** 강제 재적재(관리자, §5.1 `POST /admin/cache/{key}/reload`). */
  async reload(projectId: number): Promise<CachedSnapshot> {
    this.invalidate(projectId);
    return this.get(projectId);
  }
}

@Injectable()
export class TermCacheRegistry extends TermCacheCore implements OnModuleDestroy {
  private readonly logger = new Logger('TermCache');

  constructor(@Inject(DRIZZLE) db: Db, @Optional() config?: ConfigService<Env, true>) {
    super((projectId) => loadTermSnapshot(db, projectId), {
      maxProjects: config?.get('TERMFLOW_CACHE_MAX_PROJECTS', { infer: true }) ?? 20,
    });
    this.startSweeper();
  }

  override async get(projectId: number): Promise<CachedSnapshot> {
    const r = await super.get(projectId);
    if (r.loaded) {
      const c = r.snapshot.counts;
      this.logger.log(
        `캐시 적재 project=${projectId} v${r.cacheVersion} ${r.loadMs}ms 용어 ${c.terms}·도메인 ${c.domains}·분류 ${c.domainCls}·코드구분 ${c.codeCls}`,
      );
    }
    return r;
  }

  onModuleDestroy(): void {
    this.stopSweeper();
  }
}
