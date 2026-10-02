import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { useToastStore } from '../../stores/toast.js';
import ConfirmDeleteModal from './ConfirmDeleteModal.vue';
import DataTable from './DataTable.vue';
import TfBadge from './TfBadge.vue';
import TfButton from './TfButton.vue';
import ToastRegion from './ToastRegion.vue';

// T4.9 공통 UI 컴포넌트 동작(목업 클래스·접근성 속성). 시각 비교는 메인 세션 검수(UX 확인)
describe('TfBadge·TfButton', () => {
  it('배지 의미 색은 목업 클래스와 같다(코드 = 파랑, 기본컬럼 = 회색)', () => {
    expect(
      mount(TfBadge, { props: { kind: 'std' }, slots: { default: '표준' } }).classes(),
    ).toEqual(['badge', 'badge-std']);
    expect(mount(TfBadge, { props: { kind: 'code' } }).classes()).toContain('badge-info');
    expect(mount(TfBadge, { props: { kind: 'default' } }).classes()).toContain('badge-gray');
  });
  it('loading 버튼은 스피너 + 비활성 + aria-busy', () => {
    const b = mount(TfButton, {
      props: { variant: 'primary', loading: true },
      slots: { default: '저장' },
    });
    expect(b.classes()).toEqual(expect.arrayContaining(['btn', 'btn-primary']));
    expect(b.attributes('disabled')).toBeDefined();
    expect(b.attributes('aria-busy')).toBe('true');
    expect(b.find('.spinner').exists()).toBe(true);
  });
});

describe('ToastRegion', () => {
  it('aria-live=polite, 성공은 3초 후 자동 닫힘, 오류는 [닫기] 또는 8초 뒤(CR-15 C6)', async () => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    const w = mount(ToastRegion);
    const t = useToastStore();
    t.success('v4 저장됨');
    t.error('저장 실패');
    await flushPromises();
    expect(w.attributes('aria-live')).toBe('polite');
    expect(w.findAll('.toast')).toHaveLength(2);
    vi.advanceTimersByTime(3100);
    await flushPromises();
    expect(w.findAll('.toast').map((x) => x.text())).toEqual(['저장 실패 닫기']);
    await w.get('.toast-action').trigger('click');
    expect(w.findAll('.toast')).toHaveLength(0);
    t.error('복사 실패');
    vi.advanceTimersByTime(7900);
    await flushPromises();
    expect(w.findAll('.toast')).toHaveLength(1);
    vi.advanceTimersByTime(200);
    await flushPromises();
    expect(w.findAll('.toast')).toHaveLength(0);
    vi.useRealTimers();
  });

  it('같은 문구는 쌓지 않고 시간만 다시 잰다, 최대 3개(오래된 것부터 닫힘)', async () => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    const w = mount(ToastRegion);
    const t = useToastStore();
    const a = t.error('오류 1건을 해결하면 저장할 수 있습니다');
    vi.advanceTimersByTime(5000);
    expect(t.error('오류 1건을 해결하면 저장할 수 있습니다')).toBe(a);
    vi.advanceTimersByTime(5000); // 첫 표시부터 10초 — 다시 쟀으므로 아직 떠 있다
    await flushPromises();
    expect(w.findAll('.toast')).toHaveLength(1);
    t.info('하나');
    t.info('둘');
    t.info('셋');
    await flushPromises();
    expect(w.findAll('.toast').map((x) => x.text())).toEqual(['하나', '둘', '셋']);
    t.dismiss(null);
    vi.useRealTimers();
  });
});

describe('DataTable', () => {
  const rows = [
    { id: 1, name: '나', n: 3 },
    { id: 2, name: '가', n: 10 },
    { id: 3, name: '다', n: 1 },
  ];
  const Host = defineComponent({
    setup() {
      const sort = ref<{ key: string; dir: 'asc' | 'desc' } | null>(null);
      const selected = ref<(string | number)[]>([]);
      const page = ref(1);
      return () =>
        h(DataTable, {
          columns: [
            { key: 'name', label: '이름', sortable: true },
            { key: 'n', label: '수', sortable: true },
          ],
          rows,
          rowKey: 'id',
          selectable: true,
          localSort: true,
          total: 45,
          sort: sort.value,
          'onUpdate:sort': (v: typeof sort.value) => (sort.value = v),
          selected: selected.value,
          'onUpdate:selected': (v: (string | number)[]) => (selected.value = v),
          page: page.value,
          'onUpdate:page': (v: number) => (page.value = v),
        });
    },
  });

  it('정렬: 머리글 클릭(오름 → 내림), aria-sort, 숫자 정렬', async () => {
    const w = mount(Host);
    const names = () => w.findAll('tbody tr').map((r) => r.findAll('td')[1]!.text());
    const th = w.findAll('th.th-sort');
    await th[0]!.trigger('click');
    expect(names()).toEqual(['가', '나', '다']);
    expect(th[0]!.attributes('aria-sort')).toBe('ascending');
    await th[0]!.trigger('click');
    expect(names()).toEqual(['다', '나', '가']);
    await th[1]!.trigger('keydown', { key: 'Enter' });
    expect(w.findAll('tbody tr').map((r) => r.findAll('td')[2]!.text())).toEqual(['1', '3', '10']);
  });

  it('선택: 행 선택 → 전체 선택(indeterminate 거쳐) → 해제', async () => {
    const w = mount(Host);
    const boxes = () => w.findAll('input[type="checkbox"]');
    await boxes()[1]!.setValue(true);
    expect((boxes()[0]!.element as HTMLInputElement).indeterminate).toBe(true);
    expect(w.findAll('tr.is-selected')).toHaveLength(1);
    await boxes()[0]!.trigger('change');
    expect(w.findAll('tr.is-selected')).toHaveLength(3);
    await boxes()[0]!.trigger('change');
    expect(w.findAll('tr.is-selected')).toHaveLength(0);
  });

  it('페이지네이션: 총 45건 / 20 = 3페이지, 다음·이전', async () => {
    const w = mount(Host);
    expect(w.get('.pagination .info').text()).toBe('총 45건 · 1/3 페이지');
    await w.get('button[aria-label="다음 페이지"]').trigger('click');
    expect(w.get('.pagination .info').text()).toBe('총 45건 · 2/3 페이지');
    expect(w.get('button[aria-label="이전 페이지"]').attributes('disabled')).toBeUndefined();
    expect(
      [...w.get('select').element.querySelectorAll('option')].map((o) => o.textContent),
    ).toEqual(['20', '50', '100']);
  });
});

describe('ConfirmDeleteModal(모달 1/2)', () => {
  it('열리면 위험 버튼에 포커스, Esc → cancel, 확정 → confirm', async () => {
    const w = mount(ConfirmDeleteModal, {
      props: { open: false, title: 'kim 계정을 비활성화할까요?', confirmLabel: '비활성화' },
      slots: { default: '설명' },
      attachTo: document.body,
    });
    await w.setProps({ open: true });
    await flushPromises();
    expect(w.get('[role="dialog"]').attributes('aria-modal')).toBe('true');
    expect(document.activeElement?.textContent?.trim()).toBe('비활성화');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(w.emitted('cancel')).toHaveLength(1);
    await w.get('.btn-danger').trigger('click');
    expect(w.emitted('confirm')).toHaveLength(1);
    w.unmount();
  });
});
