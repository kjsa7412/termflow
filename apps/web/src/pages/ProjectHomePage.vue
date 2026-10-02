<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import type { ProjectHome } from '@termflow/shared';
import { ApiError } from '../api/client.js';
import { projectsApi } from '../api/projects.js';
import { ROLE_LABEL, shortDateTime } from '../components/layout/labels.js';
import EmptyState from '../components/ui/EmptyState.vue';
import TfBadge from '../components/ui/TfBadge.vue';
import TfIcon from '../components/ui/TfIcon.vue';
import TfSkeleton from '../components/ui/TfSkeleton.vue';
import { hasScreen } from '../router.js';

/**
 * 프로젝트 홈(`/projects/{key}`, 목업 03_dashboard, §10.1): 테이블 수(DRAFT/FINAL)·검토대기 용어·검토 필요 테이블·
 * 검토필요 도메인, 업무구분별 테이블 표, 최근 변경 10건. 새 테이블·DDL 내보내기는 해당 화면이 생기면 활성화된다.
 * 비멤버·없는 키는 404 화면과 같은 문구(존재 노출 방지, §10.5).
 */
const route = useRoute();
const api = projectsApi();
const home = ref<ProjectHome | null>(null);
const notFound = ref(false);
const loading = ref(true);
const key = computed(() => String(route.params['projectKey'] ?? ''));

async function load(): Promise<void> {
  loading.value = true;
  notFound.value = false;
  try {
    home.value = await api.home(key.value);
  } catch (e) {
    home.value = null;
    notFound.value = e instanceof ApiError && e.status === 404;
  } finally {
    loading.value = false;
  }
}
watch(key, load, { immediate: true });

const link = (path: string) => (hasScreen(path) ? path : null);
const reviewLink = computed(() => link(`/projects/${key.value}/standards/domains?review=true`));
const approvalsLink = computed(() => link(`/projects/${key.value}/standards/approvals`));
const tablesLink = computed(() => link(`/projects/${key.value}/tables`));
const exportLink = computed(() => link(`/projects/${key.value}/export`));
const isAdmin = computed(() => home.value?.myRole === 'ADMIN');
const usedBiz = computed(() => home.value?.bizAreas.filter((b) => b.useYn).length ?? 0);
const firstBizArea = computed(() => home.value?.bizAreas.find((b) => b.useYn) ?? null);
const firstBiz = computed(() => firstBizArea.value?.bizCd ?? null);
/** [새 테이블]: 편집자 이상 · 활성 프로젝트, 첫 사용 업무구분으로 시작(테이블 목록 [새 테이블]과 같은 경로, CR-15 C2). */
const newTableLink = computed(() => {
  const h = home.value;
  if (!h || h.myRole === 'VIEWER' || h.project.status === 'ARCHIVED') return null;
  const path = link(`/projects/${key.value}/tables/new`);
  if (!path) return null;
  return {
    path,
    query: firstBizArea.value ? { bizAreaId: String(firstBizArea.value.bizAreaId) } : {},
  };
});
const ACTION_LABEL: Record<string, string> = {
  CREATE: '생성',
  UPDATE: '저장',
  RESTORE: '복원',
  FINALIZE: 'FINAL 확정',
  UNFINALIZE: 'FINAL 해제',
  CLONE: '복제',
  MIGRATE: '승계 이관',
};
</script>

<template>
  <div v-if="loading && !home"><TfSkeleton :lines="6" /></div>
  <template v-else-if="home">
    <div class="page-header">
      <div>
        <h1 class="page-title">
          <span class="project-key">{{ home.project.key }}</span
          >{{ home.project.nm }}
        </h1>
        <p class="page-desc">
          프로젝트 홈 · {{ ROLE_LABEL[home.myRole] }} · 업무구분 {{ home.bizAreas.length }}(사용
          {{ usedBiz }})
          <template v-if="home.project.copiedFrom">
            · 표준 사전 원본: {{ home.project.copiedFrom.nm }}({{
              home.project.createdAt.slice(0, 10)
            }}
            복사)</template
          >
          · 기본 방언 PostgreSQL
          <template v-if="home.project.defaultColSetNm">
            · 기본컬럼 세트 '{{ home.project.defaultColSetNm }}'
            {{ home.project.includeDefaultCols ? '자동 포함' : '자동 포함 안 함' }}</template
          >
        </p>
      </div>
      <div class="page-actions">
        <RouterLink v-if="exportLink" class="btn btn-secondary" :to="exportLink"
          ><TfIcon name="export" />DDL 내보내기</RouterLink
        >
        <button
          v-else
          class="btn btn-secondary"
          type="button"
          disabled
          title="DDL 내보내기(준비 중)"
        >
          <TfIcon name="export" />DDL 내보내기
        </button>
        <RouterLink
          v-if="newTableLink"
          class="btn btn-primary"
          :to="newTableLink"
          data-testid="home-new-table"
          ><TfIcon name="plus" />새 테이블{{ firstBiz ? ` · ${firstBiz}` : '' }}</RouterLink
        >
      </div>
    </div>

    <div v-if="home.project.status === 'ARCHIVED'" class="alert alert-info mb-4" role="status">
      <TfIcon name="lock" />
      <div class="alert-body">
        <div class="alert-title">보관된 프로젝트 — 읽기 전용</div>
        조회·DDL은 가능하지만 수정할 수 없습니다. 복원은 시스템 관리자가 설정 › 수명주기에서 합니다.
      </div>
    </div>
    <div
      v-if="home.reviewDomainCnt > 0"
      class="alert alert-warning mb-4"
      role="status"
      data-testid="review-banner"
    >
      <TfIcon name="alert-triangle" />
      <div class="alert-body">
        <div class="alert-title">
          검토필요 도메인 {{ home.reviewDomainCnt.toLocaleString('ko-KR') }}건
        </div>
        타입·물리명을 정하지 못했거나 복사 후 재검증(C3)에서 달라진 도메인입니다. 표준 사전 ›
        도메인에서 정정하세요.
      </div>
      <div v-if="reviewLink" class="alert-actions">
        <RouterLink class="btn btn-secondary btn-sm" :to="reviewLink">확인</RouterLink>
      </div>
    </div>

    <div class="grid-4 mb-6">
      <component
        :is="tablesLink ? RouterLink : 'div'"
        class="card stat-card"
        v-bind="tablesLink ? { to: tablesLink } : {}"
      >
        <span class="stat-label">테이블</span>
        <span class="stat-value">{{ home.tables.total }}</span>
        <span class="stat-sub"
          ><TfBadge kind="draft">DRAFT {{ home.tables.draft }}</TfBadge
          ><TfBadge kind="final">FINAL {{ home.tables.final }}</TfBadge></span
        >
      </component>
      <component
        :is="approvalsLink ? RouterLink : 'div'"
        class="card stat-card"
        v-bind="approvalsLink ? { to: approvalsLink } : {}"
      >
        <span class="stat-label">검토대기 용어</span>
        <span class="stat-value">{{ home.pendingTermCnt }}</span>
        <span class="stat-sub"
          ><span>{{ isAdmin ? '승인 큐에서 처리' : '프로젝트 관리자가 승인' }}</span></span
        >
      </component>
      <div class="card stat-card">
        <span class="stat-label">검토 표시 테이블</span>
        <span class="stat-value">{{ home.tables.review }}</span>
        <span class="stat-sub"><span>PK 없음·타입 확인 등</span></span>
      </div>
      <div class="card stat-card">
        <span class="stat-label">검토필요 도메인</span>
        <span class="stat-value">{{ home.reviewDomainCnt.toLocaleString('ko-KR') }}</span>
        <span class="stat-sub"
          ><span>멤버 {{ home.memberCnt }}명</span></span
        >
      </div>
    </div>

    <div class="card card-flush mb-6">
      <div class="card-header">
        <div class="card-title"><TfIcon name="folder" />업무구분별 테이블</div>
        <RouterLink class="text-sm" :to="`/projects/${home.project.key}/biz-areas`"
          >업무구분 {{ isAdmin ? '관리' : '보기' }}</RouterLink
        >
      </div>
      <table v-if="home.bizAreas.length" class="table table-compact">
        <thead>
          <tr>
            <th>업무구분</th>
            <th>접두어</th>
            <th class="num">테이블</th>
            <th class="num">DRAFT</th>
            <th class="num">FINAL</th>
            <th class="num">검토</th>
            <th>최근 변경</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="b in home.bizAreas" :key="b.bizAreaId" :class="{ 'is-disabled': !b.useYn }">
            <td>
              <span class="mono">{{ b.bizCd }}</span> {{ b.bizNm }}
              <TfBadge v-if="!b.useYn" kind="gray">사용 중지</TfBadge>
            </td>
            <td class="mono">{{ b.tablePrefix ?? '—' }}</td>
            <td :class="['num', b.tableCnt ? 'fw-600' : 'text-muted']">{{ b.tableCnt }}</td>
            <td class="num">
              <TfBadge v-if="b.draftCnt" kind="draft">{{ b.draftCnt }}</TfBadge
              ><span v-else class="text-muted">—</span>
            </td>
            <td class="num">
              <TfBadge v-if="b.finalCnt" kind="final">{{ b.finalCnt }}</TfBadge
              ><span v-else class="text-muted">—</span>
            </td>
            <td class="num">
              <TfBadge v-if="b.reviewCnt" kind="warning">{{ b.reviewCnt }}</TfBadge
              ><span v-else class="text-muted">—</span>
            </td>
            <td class="text-muted">
              {{
                b.lastChangedAt ? `${shortDateTime(b.lastChangedAt)} ${b.lastChangedBy ?? ''}` : '—'
              }}
            </td>
          </tr>
        </tbody>
      </table>
      <EmptyState
        v-else
        in-table
        icon="folder"
        title="업무구분이 없습니다"
        desc="모든 테이블은 업무구분 하나에 속합니다. 업무구분을 먼저 만드세요."
      >
        <RouterLink
          v-if="isAdmin"
          class="btn btn-primary btn-sm"
          :to="`/projects/${home.project.key}/biz-areas`"
          ><TfIcon name="plus" />업무구분 추가</RouterLink
        >
      </EmptyState>
    </div>

    <div class="card card-flush">
      <div class="card-header">
        <div class="card-title"><TfIcon name="history" />최근 변경 이력</div>
      </div>
      <div v-if="home.recentChanges.length" class="list" style="padding: 4px 16px">
        <div v-for="c in home.recentChanges" :key="`${c.tableId}-${c.version}`" class="list-item">
          <span class="avatar sm">{{ c.savedBy.slice(0, 1) }}</span>
          <span
            ><strong>{{ c.savedBy }}</strong> · <span class="mono">{{ c.tableNm }}</span> v{{
              c.version
            }}
            {{ ACTION_LABEL[c.action] ?? c.action
            }}{{ c.changeSummary ? ` — ${c.changeSummary}` : '' }}</span
          >
          <span class="meta">{{ shortDateTime(c.savedAt) }}</span>
        </div>
      </div>
      <EmptyState
        v-else
        in-table
        icon="history"
        title="아직 변경 이력이 없습니다"
        desc="테이블을 저장하면 여기에 최근 10건이 표시됩니다."
      />
    </div>
  </template>
  <EmptyState
    v-else
    icon="folder"
    title="프로젝트를 찾을 수 없습니다"
    :desc="
      notFound
        ? '주소가 잘못되었거나 이 프로젝트의 멤버가 아닙니다.'
        : '프로젝트 정보를 불러오지 못했습니다.'
    "
  >
    <RouterLink class="btn btn-secondary" to="/projects">프로젝트 목록으로</RouterLink>
  </EmptyState>
</template>
