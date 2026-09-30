import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  DIALECT_IDENTIFIER_MAX,
  IDENTIFIER_RE,
  formatValidationMessage,
  type AutocompleteBatchRequest,
  type AutocompleteBatchResponse,
  type AutocompleteRequest,
  type AutocompleteResponse,
  type Dialect,
  type SuggestNameInput,
  type TableNameSuggestion,
  type ValidationIssue,
} from '@termflow/shared';
import { ValidationProblem } from '../common/problem/problem.exception.js';
import type { ProjectCtx } from '../common/project-context.js';
import type { Db } from '../db/client.js';
import { DRIZZLE } from '../db/db.module.js';
import { isReserved } from '../ddl/reserved-words.js';
import { rowsOf } from '../project/sql-util.js';
import { AutocompleteMetrics } from './autocomplete-metrics.js';
import { runAutocomplete, suggestTableName } from './engine.js';
import { TermCacheRegistry, type CachedSnapshot } from './term-cache-registry.js';
import { normalizeLogical } from './term-snapshot.js';

const round1 = (ms: number) => Math.round(ms * 10) / 10;
const DIALECT_LABEL: Record<Dialect, string> = {
  POSTGRESQL: 'PostgreSQL',
  ORACLE: 'Oracle',
  MYSQL: 'MySQL',
};
/** 호출당 로그 1줄 — 100ms 초과는 WARN(§5.8). */
export const AUTOCOMPLETE_WARN_MS = 100;

/**
 * 자동완성·물리명 제안 서비스(T9.3~T9.5). 엔진(`engine.ts`)은 순수 함수이고, 여기서는 캐시·측정·로그·중복 검사만 한다.
 * `elapsedMs` = 서버 내부 처리 시간(첫 요청이면 캐시 적재 포함 — 로그에 적재 소요를 따로 적는다, §5.8 "분리 보고").
 */
@Injectable()
export class AutocompleteService {
  private readonly logger = new Logger('Autocomplete');

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: TermCacheRegistry,
    private readonly metrics: AutocompleteMetrics,
  ) {}

  private async snapshot(projectId: number): Promise<CachedSnapshot> {
    const c = await this.cache.get(projectId);
    if (c.loaded) this.metrics.cacheLoad.observe(c.loadMs / 1000);
    this.metrics.cacheEntries.set(this.cache.list().length);
    return c;
  }

  private emptyInput(): never {
    throw new ValidationProblem([
      {
        code: 'E_LOGICAL_EMPTY',
        target: 'column',
        field: 'logicalNm',
        message: formatValidationMessage('E_LOGICAL_EMPTY'),
      },
    ]);
  }

  private log(ctx: ProjectCtx, what: string, ms: number, c: CachedSnapshot): void {
    const line = `${what} project=${ctx.projectKey} ${ms}ms v${c.cacheVersion}${c.loaded ? ` (캐시 적재 ${c.loadMs}ms)` : ''}`;
    if (ms > AUTOCOMPLETE_WARN_MS) this.logger.warn(line);
    else this.logger.log(line);
  }

  async column(ctx: ProjectCtx, body: AutocompleteRequest): Promise<AutocompleteResponse> {
    const t0 = performance.now();
    if (normalizeLogical(body.logicalNm) === '') this.emptyInput();
    const c = await this.snapshot(ctx.projectId);
    const r = runAutocomplete(c.snapshot, body.logicalNm, { bizAreaId: body.bizAreaId });
    const elapsedMs = round1(performance.now() - t0);
    this.metrics.observe(r.type, elapsedMs / 1000);
    this.log(ctx, `자동완성 '${r.normalized}' → ${r.type}`, elapsedMs, c);
    return { ...r, cacheVersion: c.cacheVersion, elapsedMs };
  }

  async batch(ctx: ProjectCtx, body: AutocompleteBatchRequest): Promise<AutocompleteBatchResponse> {
    const t0 = performance.now();
    if (body.logicalNms.some((x) => normalizeLogical(x) === '')) this.emptyInput();
    const c = await this.snapshot(ctx.projectId);
    const items = body.logicalNms.map((nm) => {
      const t1 = performance.now();
      const r = runAutocomplete(c.snapshot, nm, { bizAreaId: body.bizAreaId });
      const ms = round1(performance.now() - t1);
      this.metrics.observe(r.type, ms / 1000);
      return { ...r, cacheVersion: c.cacheVersion, elapsedMs: ms };
    });
    const elapsedMs = round1(performance.now() - t0);
    this.log(ctx, `자동완성 일괄 ${items.length}건`, elapsedMs, c);
    return { items, cacheVersion: c.cacheVersion, elapsedMs };
  }

  /** POST P/tables/suggest-name(§5.5): 접두어 + 분절, 형식·길이·예약어·프로젝트 내 중복(E_TABLE_NM_DUP). */
  async suggestName(ctx: ProjectCtx, body: SuggestNameInput): Promise<TableNameSuggestion> {
    const t0 = performance.now();
    if (normalizeLogical(body.logicalNm) === '') this.emptyInput();
    const c = await this.snapshot(ctx.projectId);
    const s = suggestTableName(c.snapshot, body.logicalNm, body.bizAreaId);
    const errors: ValidationIssue[] = [];
    const base = { target: 'table' as const, field: 'tableNm', tableNm: s.tableNm };
    if (s.complete) {
      const [p] = await rowsOf<{ default_dialect: Dialect }>(
        this.db,
        sql`select default_dialect from tf_project where project_id = ${ctx.projectId}`,
      );
      const dialect = p?.default_dialect ?? 'POSTGRESQL';
      const max = DIALECT_IDENTIFIER_MAX[dialect];
      const label = DIALECT_LABEL[dialect];
      if (!IDENTIFIER_RE.test(s.tableNm)) {
        errors.push({
          ...base,
          code: 'E_PHYS_FORMAT',
          message: formatValidationMessage('E_PHYS_FORMAT'),
        });
      } else {
        if (s.tableNm.length > max) {
          errors.push({
            ...base,
            code: 'E_PHYS_LEN',
            message: formatValidationMessage('E_PHYS_LEN', { max, dialect: label }),
          });
        }
        if (isReserved(dialect, s.tableNm)) {
          errors.push({
            ...base,
            code: 'E_RESERVED',
            message: formatValidationMessage('E_RESERVED', { name: s.tableNm, dialect: label }),
          });
        }
        const dup = await rowsOf<{ n: number }>(
          this.db,
          sql`select count(*)::int n from prj_table where project_id = ${ctx.projectId} and table_nm = ${s.tableNm}
                ${body.tableId !== undefined ? sql`and table_id <> ${body.tableId}` : sql``}`,
        );
        if ((dup[0]?.n ?? 0) > 0) {
          errors.push({
            ...base,
            code: 'E_TABLE_NM_DUP',
            message: formatValidationMessage('E_TABLE_NM_DUP'),
          });
        }
      }
    }
    const elapsedMs = round1(performance.now() - t0);
    this.metrics.observe('suggest', elapsedMs / 1000);
    this.log(ctx, `물리명 제안 '${body.logicalNm}' → ${s.tableNm}`, elapsedMs, c);
    return { ...s, errors, cacheVersion: c.cacheVersion };
  }
}
