import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import type { Env } from '../config/env.schema.js';
import { ProjectModule } from '../project/project.module.js';
import { ApprovalService } from './approval.service.js';
import { AuditLogService } from './audit-log.service.js';
import { CodeService } from './code.service.js';
import { DefaultColService } from './default-col.service.js';
import { DomainClsService } from './domain-cls.service.js';
import { DomainService } from './domain.service.js';
import { ImportController } from './import/import.controller.js';
import { ImportService } from './import/import.service.js';
import { ImportStore } from './import/import-store.js';
import { SearchService } from './search.service.js';
import {
  ApprovalsController,
  AuditLogsController,
  CodeClassesController,
  DefaultColumnSetsController,
  DomainClassesController,
  DomainsController,
  SearchController,
  TermsController,
} from './standard.controller.js';
import { StdWriter } from './std-write.js';
import { TermService } from './term.service.js';

/**
 * 표준 사전(단계 6, 설계서 §3.5.5~§3.5.10·§4.5·§8.5·§9.3·§9.4). 캐시 무효화는 ProjectModule이 내보내는 TermCacheRegistry.
 * 업로드는 multer 메모리 저장소(파일 1개, `TERMFLOW_UPLOAD_MAX_MB`).
 * 컨트롤러 순서: 일괄 등록(`standards/:kind/imports…`, `standards/imports/:id`)을 종류별 컨트롤러보다 먼저 등록한다.
 */
@Module({
  imports: [
    ProjectModule,
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        limits: {
          fileSize: config.get('TERMFLOW_UPLOAD_MAX_MB', { infer: true }) * 1024 * 1024,
          files: 1,
        },
      }),
    }),
  ],
  controllers: [
    ImportController,
    TermsController,
    ApprovalsController,
    DomainClassesController,
    DomainsController,
    CodeClassesController,
    DefaultColumnSetsController,
    AuditLogsController,
    SearchController,
  ],
  providers: [
    StdWriter,
    TermService,
    ApprovalService,
    DomainClsService,
    DomainService,
    CodeService,
    DefaultColService,
    AuditLogService,
    SearchService,
    ImportService,
    ImportStore,
  ],
})
export class StandardModule {}
