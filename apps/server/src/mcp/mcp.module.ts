import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { McpController } from './mcp.controller.js';
import { RouteCatalog } from './route-catalog.js';

/** 외부 에이전트 연동(CR-18): `/mcp` + REST 라우트 → 도구 목록. 켜기·끄기는 TERMFLOW_MCP_ENABLED(bearerMiddleware). */
@Module({
  imports: [DiscoveryModule],
  controllers: [McpController],
  providers: [RouteCatalog],
  exports: [RouteCatalog],
})
export class McpModule {}
