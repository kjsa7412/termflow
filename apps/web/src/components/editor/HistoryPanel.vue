<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { fillJosa, type TableHistoryDetail, type TableHistoryItem } from '@termflow/shared';
import { tablesApi } from '../../api/tables.js';
import { errMsg, fmtTs } from '../../composables/useProject.js';
import type { CompareColumn } from '../../editor/compare.js';
import { historySummary } from '../layout/labels.js';
import { useToastStore } from '../../stores/toast.js';
import TfBadge from '../ui/TfBadge.vue';
import TfButton from '../ui/TfButton.vue';
import TfIcon from '../ui/TfIcon.vue';
import TfSkeleton from '../ui/TfSkeleton.vue';
import ColumnCompare from './ColumnCompare.vue';

/**
 * 이력 패널(설계서 §8.3, 목업 08 `#hist-menu`, T8.14 — 모달 대신 우측 패널, G9). 저장 스냅샷 목록 → 버전 선택 시
 * 현재 편집본과 나란히 비교 → [이 버전으로 복원](현재 version으로 POST restore = 새 version, 선형 이력).
 * 복원 확인은 패널 안 인라인 확인(모달 2종 제한). FINAL·조회자·편집 중(dirty)에는 복원 불가.
 */
const props = defineProps<{
  projectKey: string;
  tableId: number;
  currentVersion: number;
  current: readonly CompareColumn[];
  /** 현재 편집본 테이블 정보(비교에 테이블 정보 차이도 보이도록, CR-15 C14). */
  currentTable?: {
    bizAreaId: number | null;
    tableNm: string;
    tableLogicalNm: string;
    description: string | null;
  };
  canRestore: boolean;
  /** 복원 불가 사유(확정·권한·저장 안 한 편집). */
  restoreBlocked?: string | null;
}>();
const emit = defineEmits<{ close: []; restored: [version: number, from: number] }>();
const tapi = tablesApi();
const toast = useToastStore();
const items = ref<TableHistoryItem[] | null>(null);
const picked = ref<TableHistoryDetail | null>(null);
const loading = ref(false);
const confirming = ref(false);
const busy = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try {
    items.value = await tapi.history(props.projectKey, props.tableId);
  } catch (e) {
    toast.error(errMsg(e, '이력을 불러오지 못했습니다'));
    items.value = [];
  } finally {
    loading.value = false;
  }
}
watch(() => [props.tableId, props.currentVersion], load, { immediate: true });

async function pick(v: number): Promise<void> {
  confirming.value = false;
  try {
    picked.value = await tapi.historyVersion(props.projectKey, props.tableId, v);
  } catch (e) {
    toast.error(errMsg(e, `v${v}을(를) 불러오지 못했습니다`));
  }
}
async function restore(): Promise<void> {
  if (!picked.value) return;
  busy.value = true;
  try {
    const from = picked.value.version;
    const r = await tapi.restore(props.projectKey, props.tableId, from, props.currentVersion);
    toast.success(`v${r.version} 저장됨 (v${from} 복원)`);
    picked.value = null;
    confirming.value = false;
    emit('restored', r.version, from);
  } catch (e) {
    toast.error(errMsg(e, '복원하지 못했습니다'));
  } finally {
    busy.value = false;
  }
}
const ACTION: Record<string, string> = {
  CREATE: '생성',
  UPDATE: '저장',
  RESTORE: '복원',
  FINALIZE: '확정',
  UNFINALIZE: '확정 해제',
  CLONE: '복제',
  MIGRATE: '승계',
};
const snapCols = computed(() => picked.value?.snapshot.columns ?? []);
/** 테이블 정보 차이(논리명·물리명·설명·업무구분) — 컬럼 비교만으로는 "차이 0건"으로 보였다. */
const headerDiffs = computed(() => {
  const s = picked.value?.snapshot.table;
  const c = props.currentTable;
  if (!s?.tableNm || !c) return [];
  const v = (x: string | null | undefined) => (x ?? '').trim() || '—';
  const out: { label: string; from: string; to: string }[] = [];
  if (v(s.tableLogicalNm) !== v(c.tableLogicalNm))
    out.push({ label: '논리 테이블명', from: v(s.tableLogicalNm), to: v(c.tableLogicalNm) });
  if (v(s.tableNm).toUpperCase() !== v(c.tableNm).toUpperCase())
    out.push({ label: '물리 테이블명', from: v(s.tableNm), to: v(c.tableNm) });
  if (v(s.description) !== v(c.description))
    out.push({ label: '설명', from: v(s.description), to: v(c.description) });
  if (c.bizAreaId !== null && s.bizAreaId !== c.bizAreaId)
    out.push({ label: '업무구분', from: s.bizCd, to: '다른 업무구분' });
  return out;
});
</script>

<template>
  <aside class="panel" aria-label="변경이력 패널" data-testid="history-panel">
    <div class="panel-header">
      <TfIcon name="history" />변경이력 <span class="text-sm text-muted">(저장 시 스냅샷)</span>
      <span class="spacer" />
      <button
        class="btn btn-ghost btn-sm btn-icon"
        type="button"
        aria-label="이력 패널 닫기"
        @click="emit('close')"
      >
        <TfIcon name="x" />
      </button>
    </div>
    <div class="panel-body">
      <TfSkeleton v-if="loading && !items" :lines="4" />
      <div v-else class="list" role="list">
        <div
          v-for="h in items ?? []"
          :key="h.version"
          :class="['list-item', { 'is-active': picked?.version === h.version }]"
          role="listitem"
        >
          <TfBadge kind="outline" mono>v{{ h.version }}</TfBadge>
          <span class="grow"
            >{{ ACTION[h.action] ?? h.action
            }}{{
              historySummary(h.changeSummary) ? ` · ${historySummary(h.changeSummary)}` : ''
            }}</span
          >
          <span class="meta"
            >{{ h.savedByNm ?? h.savedBy }} {{ fmtTs(h.savedAt) }}
            <button
              v-if="h.version !== currentVersion"
              class="btn-link"
              type="button"
              @click="pick(h.version)"
            >
              비교
            </button>
            <span v-else class="text-muted">현재</span>
          </span>
        </div>
      </div>

      <template v-if="picked">
        <div class="section-title">v{{ picked.version }} ↔ 현재 편집본</div>
        <div v-if="headerDiffs.length > 0" class="alert alert-info" data-testid="header-diff">
          <TfIcon name="info" />
          <div class="alert-body">
            <div class="alert-title">테이블 정보 차이 {{ headerDiffs.length }}건</div>
            <div v-for="d in headerDiffs" :key="d.label" class="text-sm">
              {{ d.label }}: {{ d.from }} → {{ d.to }}
            </div>
          </div>
        </div>
        <ColumnCompare
          :left="snapCols"
          :right="current"
          :left-title="`v${picked.version} (${ACTION[picked.action] ?? picked.action})`"
          :left-meta="`${picked.savedByNm ?? picked.savedBy} · ${fmtTs(picked.savedAt)}`"
          right-title="현재 편집본"
        />
        <div v-if="!confirming" class="row">
          <TfButton
            variant="secondary"
            icon="history"
            :disabled="!canRestore"
            :title="restoreBlocked ?? undefined"
            @click="confirming = true"
            >{{ fillJosa(`v${picked.version}(으)로 복원`) }}</TfButton
          >
          <span v-if="restoreBlocked" class="text-sm text-muted">{{ restoreBlocked }}</span>
        </div>
        <div v-else class="alert alert-warning" role="group" aria-label="복원 확인">
          <TfIcon name="alert-triangle" />
          <div class="alert-body">
            <div class="alert-title">
              v{{ picked.version }}의 컬럼으로 새 버전 v{{ currentVersion + 1 }}을 만듭니다
            </div>
            현재 v{{ currentVersion }}은 이력에 그대로 남습니다(선형 이력). 그 사이 삭제된 컬럼은 새
            컬럼으로 만들어집니다.
            <div class="row mt-3">
              <TfButton
                variant="primary"
                :loading="busy"
                data-testid="confirm-restore"
                @click="restore"
                >복원</TfButton
              >
              <TfButton variant="ghost" @click="confirming = false">취소</TfButton>
            </div>
          </div>
        </div>
      </template>
    </div>
  </aside>
</template>
