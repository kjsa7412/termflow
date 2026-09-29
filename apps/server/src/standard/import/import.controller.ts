import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import {
  importApplySchema,
  importPreviewQuerySchema,
  type ImportApplyResponse,
  type ImportPreview,
} from '@termflow/shared';
import type { z } from 'zod';
import { ProjectRole } from '../../auth/decorators.js';
import { AuditContext } from '../../common/audit/audit-context.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import type { ProjectCtx } from '../../common/project-context.js';
import { ImportService, type UploadedXlsx } from './import.service.js';

const ctxOf = (req: Request): ProjectCtx => req.projectCtx!;
/** 업로드 직후 응답의 첫 페이지 크기(미리보기 표). */
const FIRST_PAGE = { page: 1, size: 100 } as const;

/** RFC 6266/5987 파일명(한글) — ASCII 대체 이름 + UTF-8 이름. */
export function attachment(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * 엑셀 일괄 등록(T6.9, 설계서 §9.3·§9.4). 템플릿 다운로드 = 조회자(§7.3), 업로드·적용·취소 = 프로젝트 관리자.
 * 업로드는 multer 메모리 저장소 + 크기 상한(`TERMFLOW_UPLOAD_MAX_MB`, 초과 413) — 임시 파일을 만들지 않는다(§12.2).
 */
@Controller('projects/:projectKey/standards')
export class ImportController {
  constructor(
    private readonly imports: ImportService,
    private readonly auditCtx: AuditContext,
  ) {}

  @Get(':kind/imports/template')
  @ProjectRole('VIEWER')
  async template(@Param('kind') kind: string, @Res() res: Response): Promise<void> {
    const t = await this.imports.template(kind);
    res
      .status(200)
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .setHeader('Content-Disposition', attachment(t.fileName))
      .send(t.buffer);
  }

  @Post(':kind/imports')
  @ProjectRole('ADMIN')
  @UseInterceptors(FileInterceptor('file'))
  @HttpCode(201)
  upload(
    @Req() req: Request,
    @Param('kind') kind: string,
    @UploadedFile() file: UploadedXlsx | undefined,
  ): Promise<ImportPreview> {
    return this.imports.preview(ctxOf(req), req.authUser!.id, kind, file, FIRST_PAGE);
  }

  @Get('imports/:importId')
  @ProjectRole('ADMIN')
  get(
    @Req() req: Request,
    @Param('importId', new ParseUUIDPipe()) importId: string,
    @Query(new ZodValidationPipe(importPreviewQuerySchema))
    q: z.output<typeof importPreviewQuerySchema>,
  ): ImportPreview {
    return this.imports.get(ctxOf(req), req.authUser!.id, importId, q);
  }

  @Post('imports/:importId/apply')
  @ProjectRole('ADMIN')
  @HttpCode(200)
  apply(
    @Req() req: Request,
    @Param('importId', new ParseUUIDPipe()) importId: string,
    @Body(new ZodValidationPipe(importApplySchema)) body: z.output<typeof importApplySchema>,
  ): Promise<ImportApplyResponse> {
    return this.imports.apply(
      ctxOf(req),
      req.authUser!.id,
      importId,
      body.skipErrors,
      this.auditCtx.current(),
    );
  }

  @Delete('imports/:importId')
  @ProjectRole('ADMIN')
  @HttpCode(204)
  cancel(@Req() req: Request, @Param('importId', new ParseUUIDPipe()) importId: string): void {
    this.imports.cancel(ctxOf(req), req.authUser!.id, importId);
  }
}
