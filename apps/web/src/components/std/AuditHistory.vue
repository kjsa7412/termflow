<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { AuditLogItem, StdEntityType } from '@termflow/shared';
import { standardsApi } from '../../api/standards.js';
import { errMsg, fmtTs } from '../../composables/useProject.js';

/**
 * 행 '변경이력'(T6.8, §8.5 "용어·도메인 상세 변경이력 탭"). 모달 대신 행 아래 펼침(G9). 최근 20건, 바뀐 필드는 기존 → 새 값.
 */
const props = defineProps<{ projectKey: string; entityType: StdEntityType; entityId: number }>();
const api = standardsApi();
const items = ref<AuditLogItem[]>([]);
const total = ref(0);
const error = ref<string | null>(null);
const loaded = ref(false);
const ACTION: Record<string, string> = {
  INSERT: '등록',
  UPDATE: '수정',
  DELETE: '삭제',
  APPROVE: '승인',
  REJECT: '반려',
  IMPORT: '일괄',
  COPY: '복사',
};
const HIDE = new Set(['projectId', 'originProjectId', 'originId', 'reviewedAt', 'reviewedBy']);

onMounted(async () => {
  try {
    const r = await api.auditLogs(props.projectKey, {
      entityType: props.entityType,
      entityId: props.entityId,
      size: 20,
    });
    items.value = r.items;
    total.value = r.total;
  } catch (e) {
    error.value = errMsg(e, '변경이력을 불러오지 못했습니다');
  } finally {
    loaded.value = true;
  }
});
const val = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));
function diffs(it: AuditLogItem): string[] {
  const b = (it.before ?? {}) as Record<string, unknown>;
  const a = (it.after ?? {}) as Record<string, unknown>;
  return it.changedFields
    .filter(
      (k) => !HIDE.has(k) && (k in b || k in a) && it.action !== 'INSERT' && it.action !== 'DELETE',
    )
    .slice(0, 6)
    .map((k) => `${k}: ${val(b[k])} → ${val(a[k])}`);
}
</script>

<template>
  <div class="stack-sm" data-testid="audit-history">
    <div class="text-sm fw-600">
      변경이력 <span class="text-muted">({{ total }})</span>
    </div>
    <div v-if="error" class="text-sm text-danger">{{ error }}</div>
    <ul v-else-if="items.length" class="history-list">
      <li v-for="it in items" :key="it.auditId">
        <span class="badge badge-gray">{{ ACTION[it.action] ?? it.action }}</span>
        <span class="text-muted">{{ fmtTs(it.actedAt) }} · {{ it.actor }}</span>
        <span v-for="d in diffs(it)" :key="d" class="mono">{{ d }}</span>
      </li>
    </ul>
    <div v-else-if="loaded" class="text-sm text-muted">
      기록이 없습니다(승계·복사로 들어온 행은 출처만 있습니다)
    </div>
  </div>
</template>
