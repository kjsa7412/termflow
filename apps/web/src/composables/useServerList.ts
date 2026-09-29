import { onBeforeUnmount, reactive, ref, watch, type Ref } from 'vue';
import { useRoute, useRouter, type LocationQuery } from 'vue-router';
import type { Page } from '@termflow/shared';
import type { Sort } from '../components/ui/data-table.js';

export type ListQuery = Record<string, string | number | boolean | undefined>;

export interface ServerListOptions<P> {
  /** 서버 조회(검색어·필터·정렬·페이지 → 쿼리). 이전 요청은 signal로 취소된다. */
  fetch: (query: ListQuery, signal: AbortSignal) => Promise<P>;
  /** URL 쿼리와 동기화할 필터 키(예: status, review). 값은 문자열. */
  filters?: readonly string[];
  /** 검색어 입력 디바운스(ms). */
  debounceMs?: number;
  defaultSize?: number;
  /** 준비되기 전에는 조회하지 않는다(예: 프로젝트 키가 없을 때). */
  enabled?: () => boolean;
}

const str = (v: LocationQuery[string] | undefined): string =>
  (Array.isArray(v) ? (v[0] ?? '') : (v ?? '')) || '';

/**
 * 목록 공통 상태(T6.11, §10.3 목록 패턴): 검색어·필터 칩·정렬·페이지를 URL 쿼리와 동기화하고(`?review=true` 링크·새로고침 유지)
 * 서버 페이지네이션으로 조회한다. 검색어는 디바운스, 조건이 바뀌면 1페이지로, 진행 중 요청은 취소.
 */
export function useServerList<T, P extends Page<T> = Page<T>>(opts: ServerListOptions<P>) {
  const route = useRoute();
  const router = useRouter();
  const filterKeys = opts.filters ?? [];
  const q = ref(str(route.query['q']));
  const filters = reactive<Record<string, string>>(
    Object.fromEntries(filterKeys.map((k) => [k, str(route.query[k])])),
  );
  const parseSort = (v: string): Sort | null => {
    const [key, dir] = v.split(',');
    return key ? { key, dir: dir === 'desc' ? 'desc' : 'asc' } : null;
  };
  const sort = ref<Sort | null>(parseSort(str(route.query['sort'])));
  const page = ref(Number(str(route.query['page'])) || 1);
  const size = ref(Number(str(route.query['size'])) || opts.defaultSize || 20);
  const data = ref<P | null>(null) as Ref<P | null>;
  const loading = ref(false);
  const error = ref<unknown>(null);
  let ctrl: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let seq = 0;

  function query(): ListQuery {
    const out: ListQuery = { page: page.value, size: size.value };
    if (q.value.trim()) out['q'] = q.value.trim();
    for (const k of filterKeys) if (filters[k]) out[k] = filters[k];
    if (sort.value) out['sort'] = `${sort.value.key},${sort.value.dir}`;
    return out;
  }

  function syncUrl(): void {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(route.query)) {
      if (!['q', 'page', 'size', 'sort', ...filterKeys].includes(k) && typeof v === 'string')
        next[k] = v;
    }
    if (q.value.trim()) next['q'] = q.value.trim();
    for (const k of filterKeys) if (filters[k]) next[k] = filters[k]!;
    if (sort.value) next['sort'] = `${sort.value.key},${sort.value.dir}`;
    if (page.value > 1) next['page'] = String(page.value);
    if (size.value !== (opts.defaultSize ?? 20)) next['size'] = String(size.value);
    const same =
      JSON.stringify(Object.entries(next).sort()) ===
      JSON.stringify(
        Object.entries(route.query)
          .filter(([, v]) => typeof v === 'string')
          .sort(),
      );
    if (!same) void router.replace({ query: next });
  }

  async function load(): Promise<void> {
    if (opts.enabled && !opts.enabled()) return;
    ctrl?.abort();
    const c = new AbortController();
    ctrl = c;
    const my = ++seq;
    loading.value = true;
    try {
      const r = await opts.fetch(query(), c.signal);
      if (my === seq) {
        data.value = r;
        error.value = null;
      }
    } catch (e) {
      if (my === seq && !(e instanceof DOMException && e.name === 'AbortError')) error.value = e;
    } finally {
      if (my === seq) loading.value = false;
    }
    syncUrl();
  }

  function reload(): Promise<void> {
    return load();
  }

  /** 조건이 바뀌면 1페이지부터(이미 1페이지면 바로 조회, 아니면 page 감시가 조회). */
  function restart(): void {
    if (page.value !== 1) page.value = 1;
    else void load();
  }

  /** 필터 변경(필터 칩). */
  function setFilter(k: string, v: string): void {
    filters[k] = v;
    restart();
  }

  watch(q, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(restart, opts.debounceMs ?? 250);
  });
  watch([sort, size], restart);
  // 바깥에서 URL이 바뀌면(전역 검색 결과·홈 배너 링크로 같은 화면에 다시 들어옴) 상태를 맞춘다
  watch(
    () => route.query,
    (rq) => {
      const nq = str(rq['q']);
      if (nq !== q.value.trim()) q.value = nq;
      let changed = false;
      for (const k of filterKeys) {
        const v = str(rq[k]);
        if ((filters[k] ?? '') !== v) {
          filters[k] = v;
          changed = true;
        }
      }
      if (changed) restart();
    },
  );
  watch(page, () => void load());
  onBeforeUnmount(() => {
    ctrl?.abort();
    if (timer) clearTimeout(timer);
  });

  return { q, filters, sort, page, size, data, loading, error, load, reload, setFilter, query };
}
