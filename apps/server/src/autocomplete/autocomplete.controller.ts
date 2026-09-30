import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import {
  autocompleteBatchSchema,
  autocompleteRequestSchema,
  suggestNameSchema,
  type AutocompleteBatchResponse,
  type AutocompleteResponse,
  type CacheEntryItem,
  type CacheStatusResponse,
  type TableNameSuggestion,
} from '@termflow/shared';
import type { z } from 'zod';
import { ProjectRole, Public, SysAdmin } from '../auth/decorators.js';
import { NotFoundProblem } from '../common/problem/problem.exception.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import type { ProjectCtx } from '../common/project-context.js';
import type { Db } from '../db/client.js';
import { DRIZZLE } from '../db/db.module.js';
import { rowsOf } from '../project/sql-util.js';
import { AutocompleteMetrics } from './autocomplete-metrics.js';
import { AutocompleteService } from './autocomplete.service.js';
import { TermCacheRegistry } from './term-cache-registry.js';

const ctxOf = (req: Request): ProjectCtx => req.projectCtx!;

/**
 * 자동완성 API(설계서 §5.4·§5.5, T9.4·T9.5). 권한(§7.3): `P/autocomplete/**`, `P/tables/suggest-name` = 편집자 이상(POST).
 * `tables/suggest-name`은 POST만 있으므로 TableEditController의 `tables/:id`(GET·PUT·DELETE)와 겹치지 않는다.
 */
@Controller('projects/:projectKey')
export class AutocompleteController {
  constructor(private readonly ac: AutocompleteService) {}

  @Post('autocomplete/columns')
  @HttpCode(200)
  @ProjectRole('EDITOR')
  column(
    @Req() req: Request,
    @Body(new ZodValidationPipe(autocompleteRequestSchema))
    body: z.output<typeof autocompleteRequestSchema>,
  ): Promise<AutocompleteResponse> {
    return this.ac.column(ctxOf(req), body);
  }

  @Post('autocomplete/columns/batch')
  @HttpCode(200)
  @ProjectRole('EDITOR')
  batch(
    @Req() req: Request,
    @Body(new ZodValidationPipe(autocompleteBatchSchema))
    body: z.output<typeof autocompleteBatchSchema>,
  ): Promise<AutocompleteBatchResponse> {
    return this.ac.batch(ctxOf(req), body);
  }

  @Post('tables/suggest-name')
  @HttpCode(200)
  @ProjectRole('EDITOR')
  suggestName(
    @Req() req: Request,
    @Body(new ZodValidationPipe(suggestNameSchema)) body: z.output<typeof suggestNameSchema>,
  ): Promise<TableNameSuggestion> {
    return this.ac.suggestName(ctxOf(req), body);
  }
}

/** 캐시 관측(§5.1, T9.10) — 시스템 관리자. */
@Controller('admin/cache')
@SysAdmin()
export class AdminCacheController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: TermCacheRegistry,
  ) {}

  private async items(): Promise<CacheEntryItem[]> {
    const list = this.cache.list();
    const ids = list.map((x) => x.projectId);
    const names =
      ids.length === 0
        ? []
        : await rowsOf<{ project_id: number; project_key: string; project_nm: string }>(
            this.db,
            sql`select project_id, project_key, project_nm from tf_project where project_id = any(${sql.param(ids)}::int[])`,
          );
    const byId = new Map(names.map((n) => [n.project_id, n]));
    return list
      .map((x) => ({
        ...x,
        projectKey: byId.get(x.projectId)?.project_key ?? null,
        projectNm: byId.get(x.projectId)?.project_nm ?? null,
      }))
      .reverse(); // 최근 사용이 위
  }

  @Get()
  async status(): Promise<CacheStatusResponse> {
    return {
      maxProjects: this.cache.opts.maxProjects,
      idleMinutes: Math.round(this.cache.opts.idleMs / 60_000),
      items: await this.items(),
      stats: { ...this.cache.stats },
    };
  }

  /** 강제 재적재(무효화 + 즉시 적재). 없는 키 404. */
  @Post(':projectKey/reload')
  @HttpCode(200)
  async reload(@Param('projectKey') key: string): Promise<CacheEntryItem> {
    const [p] = await rowsOf<{ project_id: number; project_key: string; project_nm: string }>(
      this.db,
      sql`select project_id, project_key, project_nm from tf_project where project_key = ${key}`,
    );
    if (!p) throw new NotFoundProblem('프로젝트를 찾을 수 없습니다');
    await this.cache.reload(p.project_id);
    const item = this.cache.list().find((x) => x.projectId === p.project_id)!;
    return { ...item, projectKey: p.project_key, projectNm: p.project_nm };
  }
}

/** `GET /metrics`(루트, `/api/v1` 밖, /health와 같은 익명 — 수집기는 로그인하지 않는다, CR-08 C6). */
@Public()
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: AutocompleteMetrics,
    private readonly cache: TermCacheRegistry,
  ) {}

  @Get()
  async metricsText(@Res() res: Response): Promise<void> {
    this.metrics.cacheEntries.set(this.cache.list().length);
    res.setHeader('Content-Type', this.metrics.registry.contentType);
    res.send(await this.metrics.registry.metrics());
  }
}
