import { Injectable } from '@nestjs/common';
import { Gauge, Histogram, Registry } from 'prom-client';
import type { AutocompleteType } from '@termflow/shared';

/**
 * 관측(설계서 §5.8·§12.3, T9.4): prom-client Histogram `termflow_autocomplete{type}`(초) + 캐시 적재 Histogram·적재 수 Gauge.
 * 앱 인스턴스마다 Registry를 따로 둔다(테스트가 한 프로세스에서 앱을 여러 번 만든다 — 전역 기본 레지스트리 중복 등록 방지).
 */
@Injectable()
export class AutocompleteMetrics {
  readonly registry = new Registry();
  readonly autocomplete = new Histogram({
    name: 'termflow_autocomplete',
    help: '컬럼 자동완성 처리 시간(초, 서버 내부 — 캐시 적재 포함)',
    labelNames: ['type'] as const,
    buckets: [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.3, 1],
    registers: [this.registry],
  });
  readonly cacheLoad = new Histogram({
    name: 'termflow_term_cache_load',
    help: '프로젝트 자동완성 캐시 적재 시간(초)',
    buckets: [0.05, 0.1, 0.2, 0.3, 0.5, 1, 3],
    registers: [this.registry],
  });
  readonly cacheEntries = new Gauge({
    name: 'termflow_term_cache_projects',
    help: '적재된 프로젝트 캐시 수',
    registers: [this.registry],
  });

  observe(type: AutocompleteType | 'batch' | 'suggest', seconds: number): void {
    this.autocomplete.observe({ type }, seconds);
  }
}
