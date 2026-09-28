import { Global, Module } from '@nestjs/common';
import { AuditContext } from './audit/audit-context.js';

/** 전역 공통 제공자: 감사 컨텍스트(§8.6). ClsModule은 AppModule에서 global로 등록한다. */
@Global()
@Module({
  providers: [AuditContext],
  exports: [AuditContext],
})
export class CommonModule {}
