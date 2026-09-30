import { Module } from '@nestjs/common';
import { DdlService } from './ddl.service.js';
import { TableCloneService } from './table-clone.service.js';
import { TableEditController } from './table-edit.controller.js';
import { TableListService } from './table-list.service.js';
import { TableService } from './table.service.js';
import { DdlController, TablesController } from './table.controller.js';

/**
 * 테이블 목록·DDL 생성·내보내기(단계 7, 설계서 §6·§9.3) + 테이블 설계 편집(단계 8, §8·§9.3).
 * DDL 엔진(`src/ddl`)은 DB·Nest 비의존 순수 모듈이고, 이 모듈이 조회(TableModel 조립)·재검증·기록·저장을 맡는다.
 */
@Module({
  controllers: [TablesController, TableEditController, DdlController],
  providers: [TableListService, DdlService, TableService, TableCloneService],
  exports: [DdlService, TableService],
})
export class TableModule {}
