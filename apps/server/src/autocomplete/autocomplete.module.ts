import { Global, Module } from '@nestjs/common';
import { AutocompleteMetrics } from './autocomplete-metrics.js';
import {
  AdminCacheController,
  AutocompleteController,
  MetricsController,
} from './autocomplete.controller.js';
import { AutocompleteService } from './autocomplete.service.js';
import { TermCacheRegistry } from './term-cache-registry.js';

/**
 * 자동완성 엔진(단계 9, 설계서 §5). 캐시(TermCacheRegistry)는 표준·업무구분 쓰기(무효화)·테이블 검증(재분절 힌트)·
 * 자동완성이 함께 쓰므로 전역 모듈로 1개만 둔다(앱 인스턴스당 캐시 1벌).
 */
@Global()
@Module({
  controllers: [AutocompleteController, AdminCacheController, MetricsController],
  providers: [TermCacheRegistry, AutocompleteMetrics, AutocompleteService],
  exports: [TermCacheRegistry, AutocompleteService],
})
export class AutocompleteModule {}
