import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  API_ERROR_CODES,
  type ImportApplyResponse,
  type ImportKind,
  type ImportPreview,
  type ImportRowStatus,
  type ImportSummary,
  type ImportRow,
} from '@termflow/shared';
import type { Audit } from '../../common/audit/audit.js';
import { NotFoundProblem, ValidationProblem } from '../../common/problem/problem.exception.js';
import type { ProjectCtx } from '../../common/project-context.js';
import type { Db } from '../../db/client.js';
import { DRIZZLE } from '../../db/db.module.js';
import { StdWriter } from '../std-write.js';
import { bizAreasEngine } from './biz-areas.engine.js';
import { codeClassesEngine } from './code-classes.engine.js';
import { domainClassesEngine } from './domain-classes.engine.js';
import { domainsEngine } from './domains.engine.js';
import type { KindEngine } from './engine.js';
import { ImportStore, type ImportEntry } from './import-store.js';
import { termsEngine } from './terms.engine.js';
import { buildTemplate, readSheet } from './xlsx.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- 종류별 엔진 상태·연산 타입은 엔진 안에서만 쓴다 */
export const IMPORT_ENGINES: Record<ImportKind, KindEngine<any, any>> = {
  'biz-areas': bizAreasEngine,
  terms: termsEngine,
  'domain-classes': domainClassesEngine,
  domains: domainsEngine,
  'code-classes': codeClassesEngine,
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface UploadedXlsx {
  buffer: Buffer;
  originalname: string;
  size: number;
}

export interface PreviewPageQuery {
  page: number;
  size: number;
  status?: ImportRowStatus | undefined;
  warn?: boolean | undefined;
}

/** multipart 파일명: busboy 기본(latin1)으로 풀린 UTF-8 한글 이름을 되돌린다. */
export function decodeFileName(name: string): string {
  if (!/[\u0080-ÿ]/.test(name)) return name;
  const re = Buffer.from(name, 'latin1').toString('utf8');
  return re.includes('�') ? name : re;
}

function summarize(rows: readonly ImportRow[]): ImportSummary {
  const s: ImportSummary = { new: 0, update: 0, skip: 0, error: 0, warn: 0 };
  for (const r of rows) {
    if (r.status === 'NEW') s.new++;
    else if (r.status === 'UPDATE') s.update++;
    else if (r.status === 'SKIP') s.skip++;
    else s.error++;
    if (r.warnings.some((w) => w.code.startsWith('W_'))) s.warn++;
  }
  return s;
}

const iso = (ms: number) => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/**
 * 엑셀 일괄 등록 2단계(T6.9, 설계서 §9.4): 템플릿 → 업로드(파싱·검증만, 미리보기 보관) → 적용(단일 트랜잭션, ERROR 제외,
 * 감사 IMPORT·batch_id, 캐시 무효화 1회). 적용은 현재 DB 상태로 다시 판정한다(`engine.ts`).
 */
@Injectable()
export class ImportService {
  private readonly logger = new Logger('Imports');

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly writer: StdWriter,
    private readonly store: ImportStore,
  ) {}

  engine(kind: string): KindEngine {
    const e = (IMPORT_ENGINES as Record<string, KindEngine | undefined>)[kind];
    if (!e) throw new NotFoundProblem(`일괄 등록 종류가 아닙니다: ${kind}`);
    return e;
  }

  async template(kind: string): Promise<{ buffer: Buffer; fileName: string }> {
    const e = this.engine(kind);
    return {
      buffer: await buildTemplate(e.title, e.columns, e.example, e.notes ?? []),
      fileName: `${e.title}_일괄등록_템플릿.xlsx`,
    };
  }

  private columns(e: KindEngine): ImportPreview['columns'] {
    return [
      ...e.columns.map((c) => ({ key: c.key, label: c.label, required: c.required })),
      ...(e.computed ?? []).map((c) => ({ ...c, required: false, computed: true })),
    ];
  }

  private view(entry: ImportEntry, q: PreviewPageQuery): ImportPreview {
    const e = this.engine(entry.kind);
    const filtered = entry.rows.filter(
      (r) =>
        (q.status === undefined || r.status === q.status) &&
        (q.warn !== true || r.warnings.some((w) => w.code.startsWith('W_'))),
    );
    return {
      importId: entry.importId,
      kind: entry.kind,
      fileName: entry.fileName,
      totalRows: entry.rows.length,
      summary: entry.summary,
      columns: this.columns(e),
      createdAt: iso(entry.createdAt),
      expiresAt: iso(entry.expiresAt),
      elapsedMs: entry.elapsedMs,
      items: filtered.slice((q.page - 1) * q.size, q.page * q.size),
      page: q.page,
      size: q.size,
      total: filtered.length,
    };
  }

  async preview(
    ctx: ProjectCtx,
    userId: number,
    kind: string,
    file: UploadedXlsx | undefined,
    q: PreviewPageQuery,
  ): Promise<ImportPreview> {
    this.writer.assertWritable(ctx);
    const e = this.engine(kind);
    if (!file || file.size === 0) {
      throw new ValidationProblem([
        {
          code: 'E_IMPORT_FILE',
          target: 'field',
          field: 'file',
          message: '업로드할 xlsx 파일(file)이 없습니다',
        },
      ]);
    }
    const t0 = performance.now();
    const raw = await readSheet(file.buffer, e.columns);
    const state = await e.load(this.db, ctx.projectId);
    const rows = e.plan(raw, state).map((p) => p.row);
    const elapsedMs = Math.round(performance.now() - t0);
    const entry = this.store.put({
      userId,
      projectId: ctx.projectId,
      kind: e.kind,
      fileName: decodeFileName(file.originalname),
      elapsedMs,
      raw,
      rows,
      summary: summarize(rows),
    });
    this.logger.log(
      `일괄 등록 미리보기: ${ctx.projectKey} ${e.kind} ${rows.length}행(신규 ${entry.summary.new}·갱신 ${entry.summary.update}·동일 ${entry.summary.skip}·오류 ${entry.summary.error}) ${elapsedMs}ms`,
    );
    return this.view(entry, q);
  }

  private entry(ctx: ProjectCtx, userId: number, importId: string): ImportEntry {
    const entry = this.store.get(importId, userId, ctx.projectId);
    if (!entry) throw new NotFoundProblem(API_ERROR_CODES.E_IMPORT_NOT_FOUND);
    return entry;
  }

  get(ctx: ProjectCtx, userId: number, importId: string, q: PreviewPageQuery): ImportPreview {
    return this.view(this.entry(ctx, userId, importId), q);
  }

  cancel(ctx: ProjectCtx, userId: number, importId: string): void {
    this.entry(ctx, userId, importId);
    this.store.delete(importId);
  }

  async apply(
    ctx: ProjectCtx,
    userId: number,
    importId: string,
    skipErrors: boolean,
    a: Audit,
  ): Promise<ImportApplyResponse> {
    const entry = this.entry(ctx, userId, importId);
    const e = this.engine(entry.kind);
    // 미리보기 이후 보관·삭제되었을 수 있다 — 적용 직전에 DB에서 다시 확인
    await this.writer.assertWritableNow(ctx.projectId, ctx.sysAdmin);
    const t0 = performance.now();
    const batchId = randomUUID();
    const r = await this.writer.write(ctx, async (tx) => {
      const state = await e.load(tx, ctx.projectId);
      const planned = e.plan(entry.raw, state);
      const errors = planned.filter((p) => p.row.status === 'ERROR').length;
      if (errors > 0 && !skipErrors) {
        throw new ValidationProblem(
          [
            {
              code: 'E_IMPORT_HAS_ERRORS',
              target: 'all',
              message: `${API_ERROR_CODES.E_IMPORT_HAS_ERRORS}: 오류 ${errors}행`,
            },
          ],
          [],
          `${API_ERROR_CODES.E_IMPORT_HAS_ERRORS}(오류 ${errors}행)`,
        );
      }
      const applied = await e.apply(tx, ctx.projectId, planned, state, a, batchId);
      return {
        applied,
        errors,
        skipped: planned.filter((p) => p.row.status === 'SKIP').length,
      };
    });
    this.store.delete(importId);
    const elapsedMs = Math.round(performance.now() - t0);
    this.logger.log(
      `일괄 등록 적용: ${ctx.projectKey} ${e.kind} 신규 ${r.applied.new}·갱신 ${r.applied.update}·동일 ${r.skipped}·오류 제외 ${r.errors} (${elapsedMs}ms, batch ${batchId}) by ${a.actor}`,
    );
    return { ...r, batchId, elapsedMs };
  }
}
