import { Module } from '@nestjs/common';
import { DdlService } from './ddl.service.js';
import { TableListService } from './table-list.service.js';
import { DdlController, TablesController } from './table.controller.js';

/**
 * 테이블 목록·DDL 생성·내보내기(단계 7, 설계서 §6·§9.3). DDL 엔진(`src/ddl`)은 DB·Nest 비의존 순수 모듈이고,
 * 이 모듈이 조회(TableModel 조립)·재검증·기록을 맡는다. 테이블 쓰기 API는 단계 8에서 같은 모듈에 추가한다.
 */
@Module({
  controllers: [TablesController, DdlController],
  providers: [TableListService, DdlService],
  exports: [DdlService],
})
export class TableModule {}
