<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import {
  STD_TYPES,
  type DomainCalcResult,
  type DomainItem,
  type DomainPage,
  type DomainRecalcResponse,
  type StdType,
} from '@termflow/shared';
import { standardsApi, type DomainBody } from '../api/standards.js';
import AuditHistory from '../components/std/AuditHistory.vue';
import FilterSeg from '../components/std/FilterSeg.vue';
import ListPager from '../components/std/ListPager.vue';
import SearchBox from '../components/std/SearchBox.vue';
import ConfirmDeleteModal from '../components/ui/ConfirmDeleteModal.vue';
import EmptyState from '../components/ui/EmptyState.vue';
import TfButton from '../components/ui/TfButton.vue';
import TfIcon from '../components/ui/TfIcon.vue';
import TfPopover from '../components/ui/TfPopover.vue';
import TfSkeleton from '../components/ui/TfSkeleton.vue';
import { errMsg, fmtNum, fmtTs, useProject } from '../composables/useProject.js';
import { useServerList } from '../composables/useServerList.js';
import { useToastStore } from '../stores/toast.js';

/**
 * 도메인(`/projects/{key}/standards/domains`, 목업 06, §5.2): 명칭 조각 1~7 → L1 즉시 미리보기(논리명·물리명·접미어 → 타입·
 * 조각 배지), 수기 타입 토글, Enter 등록. 목록은 검토필요(`?review=true` — 홈·마법사 C3 배너 링크 대상)·물리명 없음·수동 타입·
 * 접미어 필터, [재계산](REVIEW_ONLY/ALL_AUTO, 프로젝트 관리자). 수정은 같은 계산 카드를 수정 모드로 쓴다.
 */
const { key, project, canWrite } = useProject();
const api = standardsApi();
const toast = useToastStore();
const list = useServerList<DomainItem, DomainPage>({
  filters: ['review', 'noPhysical', 'typeSource', 'suffix'],
  enabled: () => key.value !== '',
  fetch: (q) => api.domains(key.value, q),
});
watch(key, () => void list.reload(), { immediate: true });
const page = computed(() => list.data.value);
const notFound = computed(() => (list.error.value as { status?: number } | null)?.status === 404);

// 상태 칩: 검토필요 / 물리명 없음 / 수동 타입 중 하나
const seg = computed(() =>
  list.filters['review'] === 'true'
    ? 'review'
    : list.filters['noPhysical'] === 'true'
      ? 'noPhysical'
      : list.filters['typeSource'] === 'MANUAL'
        ? 'manual'
        : '',
);
const segs = computed(() => [
  { value: '', label: '전체', count: page.value?.counts.all },
  { value: 'review', label: '검토필요', count: page.value?.counts.review },
  { value: 'noPhysical', label: '물리명 없음', count: page.value?.counts.noPhysical },
  { value: 'manual', label: '수동 타입', count: page.value?.counts.manual },
]);
function pickSeg(v: string): void {
  list.filters['review'] = v === 'review' ? 'true' : '';
  list.filters['noPhysical'] = v === 'noPhysical' ? 'true' : '';
  list.filters['typeSource'] = v === 'manual' ? 'MANUAL' : '';
  list.setFilter('suffix', list.filters['suffix'] ?? '');
}
const suffixInput = ref(list.filters['suffix'] ?? '');
watch(
  () => list.filters['suffix'],
  (v) => (suffixInput.value = v ?? ''),
);
function applySuffix(): void {
  list.setFilter('suffix', suffixInput.value.trim().toUpperCase());
}

// ── 계산 카드(등록·수정) ────────────────────────────────────────
interface Composer {
  nm: string[];
  manual: boolean;
  colType: StdType;
  colLength: string;
  colScale: string;
}
const blank = (): Composer => ({
  nm: ['', '', '', '', '', '', ''],
  manual: false,
  colType: 'VARCHAR',
  colLength: '',
  colScale: '',
});
const composerOpen = ref(false);
const editing = ref<DomainItem | null>(null);
const c = reactive<Composer>(blank());
const slots = ref(4);
const calc = ref<DomainCalcResult | null>(null);
const busy = ref(false);
const firstInput = ref<HTMLInputElement[] | null>(null);
const num = (v: string) => (v.trim() === '' ? null : Number(v));
function body(): DomainBody {
  const n = c.nm.map((v) => v.trim() || null);
  return {
    nm1: n[0] ?? null,
    nm2: n[1] ?? null,
    nm3: n[2] ?? null,
    nm4: n[3] ?? null,
    nm5: n[4] ?? null,
    nm6: n[5] ?? null,
    nm7: n[6] ?? null,
    typeSource: c.manual ? 'MANUAL' : 'AUTO',
    colType: c.manual ? c.colType : null,
    colLength: c.manual ? num(c.colLength) : null,
    colScale: c.manual ? num(c.colScale) : null,
  };
}
let calcTimer: ReturnType<typeof setTimeout> | null = null;
let calcCtrl: AbortController | null = null;
watch(
  () => [c.nm.join('|'), c.manual, c.colType, c.colLength, c.colScale],
  () => {
    if (calcTimer) clearTimeout(calcTimer);
    if (c.nm.every((v) => !v.trim())) {
      calc.value = null;
      return;
    }
    calcTimer = setTimeout(async () => {
      calcCtrl?.abort();
      calcCtrl = new AbortController();
      try {
        calc.value = await api.calculate(
          key.value,
          { ...body(), domainId: editing.value?.domainId ?? null },
          calcCtrl.signal,
        );
      } catch {
        /* 입력 중 취소 */
      }
    }, 200);
  },
);
function openComposer(): void {
  editing.value = null;
  Object.assign(c, blank());
  slots.value = 4;
  composerOpen.value = !composerOpen.value;
  calc.value = null;
}
function startEdit(d: DomainItem): void {
  editing.value = d;
  composerOpen.value = true;
  Object.assign(c, {
    nm: d.nm.map((v) => v ?? ''),
    manual: d.typeSource === 'MANUAL',
    colType: d.colType ?? 'VARCHAR',
    colLength: d.colLength === null ? '' : String(d.colLength),
    colScale: d.colScale === null ? '' : String(d.colScale),
  });
  slots.value = Math.max(4, d.nm.filter(Boolean).length);
  window.scrollTo?.({ top: 0 });
}
function reset(): void {
  Object.assign(c, blank());
  editing.value = null;
  calc.value = null;
  firstInput.value?.[0]?.focus();
}
const canSubmit = computed(
  () => calc.value !== null && calc.value.errors.length === 0 && !busy.value,
);
async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  busy.value = true;
  const wasEdit = editing.value;
  try {
    const r = wasEdit
      ? await api.updateDomain(key.value, wasEdit.domainId, body())
      : await api.createDomain(key.value, body());
    const d = r.domain;
    toast.success(
      `'${d.logicalNm} ${d.physicalNm ?? '(물리명 없음)'} ${d.typeText ?? ''}' ${wasEdit ? '저장' : '등록'}했습니다${d.reviewYn ? ' · 검토필요' : ''}`,
    );
    reset();
    if (wasEdit) composerOpen.value = false;
    await list.reload();
  } catch (e) {
    toast.error(errMsg(e, '저장하지 못했습니다'));
  } finally {
    busy.value = false;
  }
}

// ── 재계산 ──────────────────────────────────────────────────────
const recalcResult = ref<DomainRecalcResponse | null>(null);
async function recalculate(scope: 'REVIEW_ONLY' | 'ALL_AUTO', close: () => void): Promise<void> {
  close();
  busy.value = true;
  try {
    recalcResult.value = await api.recalculate(key.value, scope);
    const r = recalcResult.value;
    toast.success(
      `재계산 완료 — 변경 ${fmtNum(r.updated)} · 검토 해제 ${fmtNum(r.resolved)} · 남은 검토 ${fmtNum(r.stillReview)}`,
    );
    await list.reload();
  } catch (e) {
    toast.error(errMsg(e, '재계산하지 못했습니다'));
  } finally {
    busy.value = false;
  }
}
const FIELD: Record<string, string> = {
  physicalNm: '물리명',
  descr: '설명',
  suffix: '접미어',
  domainClsId: '분류',
  colType: '타입',
  colLength: '길이',
  colScale: '스케일',
  reviewYn: '검토',
  reviewNote: '검토 사유',
};
const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));

// ── 행 메뉴 ─────────────────────────────────────────────────────
const historyId = ref<number | null>(null);
const deleting = ref<{ d: DomainItem; columnCnt: number } | null>(null);
async function askDelete(d: DomainItem): Promise<void> {
  try {
    const r = await api.domain(key.value, d.domainId);
    deleting.value = { d, columnCnt: r.columnCnt };
  } catch (e) {
    toast.error(errMsg(e, '삭제 정보를 불러오지 못했습니다'));
  }
}
async function remove(): Promise<void> {
  if (!deleting.value) return;
  busy.value = true;
  try {
    const r = await api.deleteDomain(key.value, deleting.value.d.domainId);
    toast.success(
      `'${deleting.value.d.logicalNm}' 삭제했습니다${r.unlinkedColumns ? ` · 컬럼 ${r.unlinkedColumns}개 연결 해제` : ''}`,
    );
    deleting.value = null;
    await list.reload();
  } catch (e) {
    toast.error(errMsg(e, '삭제하지 못했습니다'));
  } finally {
    busy.value = false;
  }
}
const COLS = 8;
</script>

<template>
  <EmptyState v-if="notFound" icon="folder" title="프로젝트를 찾을 수 없습니다">
    <RouterLink class="btn btn-secondary" to="/projects">프로젝트 목록으로</RouterLink>
  </EmptyState>
  <template v-else>
    <div class="page-header">
      <div>
        <div class="breadcrumb">
          <RouterLink :to="`/projects/${key}`">{{ project?.nm ?? key }}</RouterLink
          ><span>›</span><span>표준 사전</span><span>›</span><span>도메인</span>
        </div>
        <h1 class="page-title">
          도메인 <span class="count-pill">{{ fmtNum(page?.counts.all) }}</span>
        </h1>
        <p class="page-desc">
          명칭 조각(1~7)을 이 프로젝트의 용어로 바꿔 만든 표준 컬럼 — 논리명·물리명·타입. 자동완성
          정확일치의 원천입니다. 마지막 비숫자 조각의 물리약어가 접미어가 되어 타입을 결정합니다.
        </p>
      </div>
      <div v-if="canWrite" class="page-actions">
        <TfPopover align="right">
          <template #trigger="{ toggle, open, menuId }">
            <button
              class="btn btn-ghost"
              type="button"
              aria-haspopup="menu"
              :aria-expanded="open"
              :aria-controls="menuId"
              :disabled="busy"
              @click="toggle"
            >
              <TfIcon name="refresh" />재계산
            </button>
          </template>
          <template #default="{ close }">
            <div class="dropdown-label">현재 용어·도메인분류로 다시 계산(수기 타입 유지)</div>
            <button
              class="dropdown-item"
              type="button"
              role="menuitem"
              @click="recalculate('REVIEW_ONLY', close)"
            >
              <TfIcon name="alert-triangle" />검토필요 도메인만
              <span class="dropdown-meta">{{ fmtNum(page?.counts.review) }}건</span>
            </button>
            <button
              class="dropdown-item"
              type="button"
              role="menuitem"
              @click="recalculate('ALL_AUTO', close)"
            >
              <TfIcon name="layers" />자동 타입 도메인 전체
            </button>
          </template>
        </TfPopover>
        <RouterLink class="btn btn-ghost" :to="`/projects/${key}/standards/domains/import`"
          ><TfIcon name="upload" />일괄 등록</RouterLink
        >
        <TfButton variant="primary" icon="plus" :aria-expanded="composerOpen" @click="openComposer"
          >도메인 등록</TfButton
        >
      </div>
    </div>

    <div v-if="recalcResult" class="alert alert-success mb-4" data-testid="recalc-result">
      <TfIcon name="check-circle" />
      <div class="alert-body">
        <div class="alert-title">
          재계산({{ recalcResult.scope === 'REVIEW_ONLY' ? '검토필요만' : '자동 타입 전체' }}) —
          대상 {{ fmtNum(recalcResult.target) }} · 변경 {{ fmtNum(recalcResult.updated) }} · 검토
          해제 {{ fmtNum(recalcResult.resolved) }} · 남은 검토
          {{ fmtNum(recalcResult.stillReview) }}
        </div>
        <ul v-if="recalcResult.report.length" class="history-list mt-2">
          <li v-for="r in recalcResult.report.slice(0, 8)" :key="r.domainId">
            <span class="fw-600">{{ r.logicalNm }}</span>
            <span v-for="(v, k) in r.changes" :key="k" class="mono text-sm"
              >{{ FIELD[k] ?? k }}: {{ show(v[0]) }} → {{ show(v[1]) }}</span
            >
          </li>
          <li v-if="recalcResult.report.length > 8" class="text-muted">
            외 {{ fmtNum(recalcResult.updated - 8) }}건(변경이력에 기록)
          </li>
        </ul>
      </div>
      <div class="alert-actions">
        <TfButton variant="ghost" size="sm" @click="recalcResult = null">닫기</TfButton>
      </div>
    </div>

    <div v-if="canWrite && composerOpen" class="card mb-4" data-testid="composer">
      <div class="card-header">
        <div class="card-title">
          <TfIcon name="layers" />{{
            editing
              ? `도메인 수정 — ${editing.logicalNm}`
              : '새 도메인 — 명칭 조각을 입력하면 즉시 계산됩니다'
          }}
        </div>
      </div>
      <div class="row wrap" @keydown.enter.prevent="submit" @keydown.esc="reset">
        <div v-for="i in slots" :key="i" class="field w-120">
          <label class="field-label" :for="`nm${i}`"
            >명칭 {{ i }}<span v-if="i === 1" class="req">*</span></label
          >
          <input
            :id="`nm${i}`"
            ref="firstInput"
            v-model="c.nm[i - 1]"
            class="input"
            :placeholder="i === 1 ? '' : '선택'"
            maxlength="100"
          />
        </div>
        <TfButton
          v-if="slots < 7"
          variant="ghost"
          size="sm"
          icon="plus"
          class="mt-4"
          @click="slots++"
          >조각 추가</TfButton
        >
      </div>
      <div class="divider" />
      <div class="grid-4" data-testid="calc">
        <div class="field">
          <span class="field-label">논리명 (자동)</span>
          <div class="fw-600">{{ calc?.logicalNm || '—' }}</div>
        </div>
        <div class="field">
          <span class="field-label">물리명 (자동)</span>
          <div v-if="calc?.physicalNm" class="mono fw-600">{{ calc.physicalNm }}</div>
          <div
            v-else-if="calc"
            class="mono text-danger"
            title="미등록 조각이 있어 저장하지 않습니다"
          >
            {{ calc.assembledPhysical }} <span class="text-sm">(저장 안 함)</span>
          </div>
          <div v-else>—</div>
        </div>
        <div class="field">
          <span class="field-label">접미어 → 타입 (자동)</span>
          <div v-if="calc">
            <span class="badge badge-outline mono">{{ calc.suffix ?? '없음' }}</span>
            <span class="mono"> {{ calc.typeText ?? '타입 없음' }}</span>
            <span v-if="calc.typeSource === 'MANUAL'" class="badge badge-info">수동</span>
          </div>
          <div v-else>—</div>
        </div>
        <div class="field">
          <span class="field-label">조각</span>
          <div v-if="calc" class="pieces">
            <template v-for="(p, i) in calc.pieces" :key="i">
              <span v-if="i > 0" class="piece-sep">│</span>
              <span
                :class="['piece', p.matched ? 'piece-ok' : 'piece-miss']"
                :title="p.matched ? '' : '미등록 용어'"
                >{{ p.kor }} <code v-if="p.matched">{{ p.physical }}</code></span
              >
            </template>
          </div>
          <div v-else>—</div>
        </div>
      </div>
      <div
        v-if="calc && (calc.errors.length || calc.reviewReasons.length)"
        class="row wrap text-sm mt-2"
      >
        <span v-for="e in calc.errors" :key="e.code + e.message" class="text-danger"
          ><TfIcon name="alert-circle" size="sm" /> {{ e.message }}</span
        >
        <span v-for="r in calc.reviewReasons" :key="r" class="text-warning"
          ><TfIcon name="alert-triangle" size="sm" /> {{ r }} → 검토필요로 등록됩니다</span
        >
        <RouterLink
          v-if="calc.notFound.length"
          :to="`/projects/${key}/standards/terms?q=${encodeURIComponent(calc.notFound[0]!)}`"
          >용어 등록하기</RouterLink
        >
      </div>
      <div class="row mt-4">
        <label class="check"
          ><input v-model="c.manual" type="checkbox" /><span class="check-box" />타입 수동
          지정</label
        >
        <select
          v-model="c.colType"
          class="select w-120"
          aria-label="수동 타입"
          :disabled="!c.manual"
        >
          <option v-for="t in STD_TYPES" :key="t" :value="t">{{ t }}</option>
        </select>
        <input
          v-model="c.colLength"
          class="input w-80 num"
          aria-label="수동 길이"
          placeholder="길이"
          :disabled="!c.manual"
        />
        <input
          v-model="c.colScale"
          class="input w-80 num"
          aria-label="수동 스케일"
          placeholder="스케일"
          :disabled="!c.manual"
        />
        <span class="spacer" />
        <span class="text-sm text-muted"
          >숫자 조각 0~10은 '_' 없이 붙습니다 · 논리명 중복 시 등록 불가</span
        >
        <TfButton
          variant="ghost"
          @click="editing ? ((editing = null), reset(), (composerOpen = false)) : reset()"
          >{{ editing ? '취소' : '초기화' }}</TfButton
        >
        <TfButton
          variant="primary"
          kbd="Enter"
          :disabled="!canSubmit"
          :loading="busy"
          @click="submit"
          >{{ editing ? '저장' : '등록' }}</TfButton
        >
      </div>
    </div>

    <div class="toolbar">
      <SearchBox v-model="list.q.value" label="도메인 검색" placeholder="논리명 · 물리명 검색" />
      <FilterSeg :model-value="seg" :options="segs" label="상태 필터" @change="pickSeg" />
      <div class="input-wrap w-160">
        <TfIcon name="filter" />
        <input
          v-model="suffixInput"
          class="input mono"
          placeholder="접미어(예: NO)"
          aria-label="접미어 필터"
          @keydown.enter="applySuffix"
          @blur="applySuffix"
        />
      </div>
    </div>

    <div class="table-wrap">
      <table class="table">
        <caption class="sr-only">
          도메인 목록
        </caption>
        <thead>
          <tr>
            <th>논리명</th>
            <th>물리명</th>
            <th>조각</th>
            <th>접미어</th>
            <th>타입</th>
            <th class="col-status">상태</th>
            <th>수정</th>
            <th class="col-menu" />
          </tr>
        </thead>
        <tbody>
          <tr v-if="list.loading.value && !page">
            <td :colspan="COLS"><TfSkeleton :lines="5" /></td>
          </tr>
          <template v-for="d in page?.items ?? []" :key="d.domainId">
            <tr :class="{ 'is-editing': editing?.domainId === d.domainId }">
              <td class="fw-600">{{ d.logicalNm }}</td>
              <td :class="d.physicalNm ? 'mono' : 'text-muted'">{{ d.physicalNm ?? '—' }}</td>
              <td>
                <span class="pieces"
                  ><span v-for="(p, i) in d.nm.filter(Boolean)" :key="i" class="piece">{{
                    p
                  }}</span></span
                >
              </td>
              <td class="mono">{{ d.suffix ?? '—' }}</td>
              <td class="mono">
                {{ d.typeText ?? '—' }}
                <span v-if="d.typeSource === 'MANUAL'" class="badge badge-info">수동</span>
              </td>
              <td>
                <span v-if="d.reviewYn" class="badge badge-warning" :title="d.reviewNote ?? ''"
                  >검토필요</span
                >
                <span v-else class="badge badge-std">표준</span>
              </td>
              <td class="text-muted">{{ d.updatedBy }} · {{ fmtTs(d.updatedAt).slice(0, 10) }}</td>
              <td class="col-menu">
                <TfPopover align="right">
                  <template #trigger="{ toggle, open, menuId }">
                    <button
                      class="btn btn-ghost btn-sm btn-icon"
                      type="button"
                      :aria-label="`${d.logicalNm} 행 메뉴`"
                      aria-haspopup="menu"
                      :aria-expanded="open"
                      :aria-controls="menuId"
                      @click="toggle"
                    >
                      <TfIcon name="more" />
                    </button>
                  </template>
                  <template #default="{ close }">
                    <button
                      v-if="canWrite"
                      class="dropdown-item"
                      type="button"
                      role="menuitem"
                      @click="(close(), startEdit(d))"
                    >
                      <TfIcon name="edit" />수정
                    </button>
                    <button
                      class="dropdown-item"
                      type="button"
                      role="menuitem"
                      @click="(close(), (historyId = historyId === d.domainId ? null : d.domainId))"
                    >
                      <TfIcon name="history" />변경이력
                    </button>
                    <template v-if="canWrite">
                      <div class="dropdown-sep" />
                      <button
                        class="dropdown-item is-danger"
                        type="button"
                        role="menuitem"
                        @click="(close(), askDelete(d))"
                      >
                        <TfIcon name="trash" />삭제
                      </button>
                    </template>
                  </template>
                </TfPopover>
              </td>
            </tr>
            <tr v-if="d.reviewYn && d.reviewNote" class="row-msg">
              <td :colspan="COLS">
                <span class="text-sm text-warning"
                  ><TfIcon name="alert-triangle" size="sm" /> {{ d.reviewNote }}</span
                >
              </td>
            </tr>
            <tr v-if="historyId === d.domainId" class="row-msg">
              <td :colspan="COLS">
                <AuditHistory :project-key="key" entity-type="DOMAIN" :entity-id="d.domainId" />
              </td>
            </tr>
          </template>
          <tr v-if="page && page.items.length === 0">
            <td :colspan="COLS">
              <EmptyState
                in-table
                icon="layers"
                title="해당하는 도메인이 없습니다"
                desc="검색어·필터를 바꾸거나 [도메인 등록]으로 추가하세요."
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <ListPager
      v-model:page="list.page.value"
      v-model:size="list.size.value"
      :total="page?.total ?? 0"
    />

    <ConfirmDeleteModal
      :open="deleting !== null"
      :title="`도메인 '${deleting?.d.logicalNm}'을(를) 삭제할까요?`"
      :busy="busy"
      @cancel="deleting = null"
      @confirm="remove"
    >
      <span v-if="deleting && deleting.columnCnt > 0"
        >이 도메인을 쓰는 컬럼 <strong>{{ deleting.columnCnt }}</strong
        >개는 연결이 해제되고 값은 그대로 남습니다('표준 도메인 아님' 배지).</span
      >
      <span v-else>이 도메인을 쓰는 컬럼은 없습니다.</span>
    </ConfirmDeleteModal>
  </template>
</template>
