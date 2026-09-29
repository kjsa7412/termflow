import { randomUUID } from 'node:crypto';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  IMPORT_PREVIEW_PER_USER_MAX,
  IMPORT_PREVIEW_TTL_MINUTES,
  type ImportKind,
  type ImportRow,
  type ImportSummary,
} from '@termflow/shared';
import type { RawRow } from './xlsx.js';

export interface ImportEntry {
  importId: string;
  userId: number;
  projectId: number;
  kind: ImportKind;
  fileName: string;
  createdAt: number;
  expiresAt: number;
  elapsedMs: number;
  raw: RawRow[];
  rows: ImportRow[];
  summary: ImportSummary;
}

const TTL_MS = IMPORT_PREVIEW_TTL_MINUTES * 60_000;
const SWEEP_MS = 5 * 60_000;

/**
 * 일괄 등록 미리보기 보관소(§9.4: 서버 메모리, importId → 사용자·프로젝트 바인딩, TTL 30분, 사용자당 5건).
 * 사용자당 상한을 넘으면 **가장 오래된 미리보기를 버린다**(CR-05 C5 — 재업로드가 막히지 않게). 단일 인스턴스 전제(§5.1).
 */
@Injectable()
export class ImportStore implements OnModuleDestroy {
  private readonly entries = new Map<string, ImportEntry>();
  private readonly timer = setInterval(() => this.sweep(), SWEEP_MS);

  constructor() {
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  put(e: Omit<ImportEntry, 'importId' | 'createdAt' | 'expiresAt'>, now = Date.now()): ImportEntry {
    this.sweep(now);
    const mine = [...this.entries.values()]
      .filter((x) => x.userId === e.userId)
      .sort((a, b) => a.createdAt - b.createdAt);
    while (mine.length >= IMPORT_PREVIEW_PER_USER_MAX) {
      const old = mine.shift()!;
      this.entries.delete(old.importId);
    }
    const entry: ImportEntry = {
      ...e,
      importId: randomUUID(),
      createdAt: now,
      expiresAt: now + TTL_MS,
    };
    this.entries.set(entry.importId, entry);
    return entry;
  }

  /** 본인·같은 프로젝트의 미만료 항목만(아니면 undefined → 404). */
  get(
    importId: string,
    userId: number,
    projectId: number,
    now = Date.now(),
  ): ImportEntry | undefined {
    const e = this.entries.get(importId);
    if (!e) return undefined;
    if (e.expiresAt <= now) {
      this.entries.delete(importId);
      return undefined;
    }
    return e.userId === userId && e.projectId === projectId ? e : undefined;
  }

  delete(importId: string): boolean {
    return this.entries.delete(importId);
  }

  countFor(userId: number): number {
    return [...this.entries.values()].filter((e) => e.userId === userId).length;
  }

  sweep(now = Date.now()): void {
    for (const [id, e] of this.entries) if (e.expiresAt <= now) this.entries.delete(id);
  }
}
