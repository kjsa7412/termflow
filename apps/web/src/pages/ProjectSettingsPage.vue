<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import type {
  CopyLogItem,
  MemberCandidate,
  MemberItem,
  MemberRole,
  ProjectSettings,
  StdEntityType,
} from '@termflow/shared';
import { ApiError } from '../api/client.js';
import { projectsApi } from '../api/projects.js';
import { ROLE_LABEL, shortDateTime } from '../components/layout/labels.js';
import ConfirmDeleteModal from '../components/ui/ConfirmDeleteModal.vue';
import EmptyState from '../components/ui/EmptyState.vue';
import TfBadge from '../components/ui/TfBadge.vue';
import TfButton from '../components/ui/TfButton.vue';
import TfIcon from '../components/ui/TfIcon.vue';
import TfSkeleton from '../components/ui/TfSkeleton.vue';
import TfToggle from '../components/ui/TfToggle.vue';
import { useSessionStore } from '../stores/session.js';
import { useToastStore } from '../stores/toast.js';

/**
 * 프로젝트 설정(`/projects/{key}/settings`, 목업 12, §4.7·§10.1): 탭 기본 정보(키 읽기 전용·표준 출처·수명주기) ·
 * 멤버(S5: 검색 → 역할 → 추가, 역할 변경 즉시 저장, 마지막 프로젝트 관리자 보호) · 기본값(방언·기본컬럼 세트).
 * 쓰기는 프로젝트 관리자(시스템 관리자 포함). 보관·복원·삭제는 시스템 관리자만(Q8 확정) — 프로젝트 관리자에게는
 * 비활성 버튼 + 요청 안내. 보관된 프로젝트는 읽기 전용.
 */
const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const toast = useToastStore();
const api = projectsApi();

type Tab = 'basic' | 'members' | 'defaults';
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'basic', label: '기본 정보', icon: 'settings' },
  { id: 'members', label: '멤버', icon: 'users' },
  { id: 'defaults', label: '기본값', icon: 'columns' },
];
const key = computed(() => String(route.params['projectKey'] ?? ''));
const tab = ref<Tab>(
  (['basic', 'members', 'defaults'] as const).find((t) => t === route.query['tab']) ?? 'basic',
);
watch(tab, (t) => void router.replace({ query: { ...route.query, tab: t } }));

const settings = ref<ProjectSettings | null>(null);
const notFound = ref(false);
const copyLog = ref<CopyLogItem[]>([]);
const myRole = computed<MemberRole>(() => {
  if (session.isSysAdmin) return 'ADMIN';
  return session.projects.find((p) => p.key === key.value)?.role ?? 'VIEWER';
});
const archived = computed(() => settings.value?.status === 'ARCHIVED');
const isTemplate = computed(() => settings.value?.kind === 'TEMPLATE');
const canWrite = computed(() => myRole.value === 'ADMIN' && !archived.value);

const form = reactive({
  projectNm: '',
  description: '',
  defaultDialect: 'POSTGRESQL' as const,
  includeDefaultCols: true,
  defaultColSetId: null as number | null,
});
function fill(s: ProjectSettings): void {
  form.projectNm = s.projectNm;
  form.description = s.description ?? '';
  form.includeDefaultCols = s.includeDefaultCols;
  form.defaultColSetId = s.defaultColSetId;
}

async function load(): Promise<void> {
  notFound.value = false;
  try {
    settings.value = await api.settings(key.value);
    fill(settings.value);
    if (myRole.value === 'ADMIN') copyLog.value = await api.copyLog(key.value).catch(() => []);
    if (!isTemplate.value) await loadMembers();
  } catch (e) {
    settings.value = null;
    notFound.value = e instanceof ApiError && e.status === 404;
  }
}
watch(key, load, { immediate: true });

// ── 기본 정보·기본값 저장 ─────────────────────────────────────
const saving = ref(false);
async function save(what: '기본 정보' | '기본값'): Promise<void> {
  if (!settings.value || !canWrite.value) return;
  saving.value = true;
  try {
    settings.value = await api.updateSettings(key.value, {
      projectNm: form.projectNm.trim(),
      description: form.description.trim() || null,
      defaultDialect: form.defaultDialect,
      includeDefaultCols: form.includeDefaultCols,
      defaultColSetId: form.defaultColSetId,
    });
    fill(settings.value);
    toast.success(
      `${what}을(를) 저장했습니다${what === '기본값' ? ' · 기존 테이블에는 영향 없음' : ''}`,
    );
    await session.refresh();
  } catch (e) {
    toast.error(
      e instanceof ApiError && e.problem?.detail ? e.problem.detail : '저장하지 못했습니다',
    );
  } finally {
    saving.value = false;
  }
}
const selectedSet = computed(
  () => settings.value?.defaultColSets.find((s) => s.setId === form.defaultColSetId) ?? null,
);
const COPY_ITEM: Partial<Record<StdEntityType, string>> = {
  BIZ_AREA: '업무구분',
  TERM: '용어',
  DOMAIN_CLS: '도메인분류',
  DOMAIN: '도메인',
  CODE_CLS: '코드구분',
  CODE: '코드',
  DEFAULT_COL: '기본컬럼',
};
const copySummary = computed(() => {
  const create = copyLog.value.filter((l) => l.operation === copyLog.value[0]?.operation);
  if (create.length === 0) return null;
  const ms = create.reduce((s, l) => s + l.elapsedMs, 0);
  return {
    text: create
      .filter((l) => COPY_ITEM[l.item])
      .map((l) => `${COPY_ITEM[l.item]} ${l.copiedCnt.toLocaleString('ko-KR')}`)
      .join(' · '),
    seconds: (ms / 1000).toFixed(1),
    at: create[0]!.copiedAt,
    by: create[0]!.copiedBy,
  };
});

// ── 수명주기(시스템 관리자) ─────────────────────────────────
const lifecycleBusy = ref(false);
async function setStatus(status: 'ACTIVE' | 'ARCHIVED'): Promise<void> {
  lifecycleBusy.value = true;
  try {
    if (isTemplate.value) await api.setTemplateStatus(key.value, status);
    else await api.setProjectStatus(key.value, status);
    toast.success(status === 'ARCHIVED' ? '보관했습니다 — 읽기 전용' : '복원했습니다');
    await session.refresh();
    await load();
  } catch (e) {
    toast.error(
      e instanceof ApiError && e.problem?.detail ? e.problem.detail : '처리하지 못했습니다',
    );
  } finally {
    lifecycleBusy.value = false;
  }
}
const deleting = ref(false);
const confirmKey = ref('');
const deleteBusy = ref(false);
async function remove(): Promise<void> {
  deleteBusy.value = true;
  try {
    if (isTemplate.value) await api.deleteTemplate(key.value, confirmKey.value);
    else await api.deleteProject(key.value, confirmKey.value);
    toast.success(`${key.value}을(를) 삭제했습니다`);
    deleting.value = false;
    await session.refresh();
    await router.push(isTemplate.value ? '/admin/templates' : '/admin/projects');
  } catch (e) {
    toast.error(
      e instanceof ApiError && e.problem?.detail ? e.problem.detail : '삭제하지 못했습니다',
    );
  } finally {
    deleteBusy.value = false;
  }
}

// ── 멤버(S5) ─────────────────────────────────────────────────
const members = ref<MemberItem[]>([]);
const loadingMembers = ref(false);
async function loadMembers(): Promise<void> {
  loadingMembers.value = true;
  try {
    members.value = await api.members(key.value);
  } finally {
    loadingMembers.value = false;
  }
}
const q = ref('');
const hits = ref<MemberCandidate[]>([]);
const pick = ref<MemberCandidate | null>(null);
const addRole = ref<MemberRole>('EDITOR');
let timer: ReturnType<typeof setTimeout> | undefined;
watch(q, (v) => {
  clearTimeout(timer);
  if (pick.value && v === pick.value.userNm) return;
  pick.value = null;
  if (v.trim() === '') {
    hits.value = [];
    return;
  }
  timer = setTimeout(async () => {
    try {
      hits.value = await api.memberCandidates(key.value, v.trim());
    } catch {
      hits.value = [];
    }
  }, 250);
});
function choose(c: MemberCandidate): void {
  if (c.isMember) return;
  pick.value = c;
  q.value = c.userNm;
  hits.value = [];
}
const adding = ref(false);
async function add(): Promise<void> {
  if (!pick.value) return;
  adding.value = true;
  try {
    const m = await api.addMember(key.value, pick.value.userId, addRole.value);
    toast.success(`${m.userNm} 님을 ${ROLE_LABEL[m.role]}(으)로 추가했습니다`);
    pick.value = null;
    q.value = '';
    await loadMembers();
  } catch (e) {
    toast.error(
      e instanceof ApiError && e.problem?.detail ? e.problem.detail : '추가하지 못했습니다',
    );
  } finally {
    adding.value = false;
  }
}
async function changeRole(m: MemberItem, role: MemberRole): Promise<void> {
  const before = m.role;
  m.role = role;
  try {
    await api.updateMember(key.value, m.userId, role);
    toast.success(`${m.userNm} 님의 역할을 ${ROLE_LABEL[role]}(으)로 바꿨습니다`);
  } catch (e) {
    m.role = before;
    toast.error(
      e instanceof ApiError && e.code === 'E_LAST_PROJECT_ADMIN'
        ? '프로젝트 관리자는 최소 1명이어야 합니다'
        : '역할을 바꾸지 못했습니다',
    );
  }
}
const removing = ref<MemberItem | null>(null);
const removeBusy = ref(false);
async function removeMember(): Promise<void> {
  const m = removing.value;
  if (!m) return;
  removeBusy.value = true;
  try {
    await api.removeMember(key.value, m.userId);
    toast.success(`${m.userNm} 님을 멤버에서 제외했습니다`);
    removing.value = null;
    await loadMembers();
  } catch (e) {
    toast.error(
      e instanceof ApiError && e.code === 'E_LAST_PROJECT_ADMIN'
        ? '마지막 프로젝트 관리자는 제외할 수 없습니다'
        : '제외하지 못했습니다',
    );
    removing.value = null;
  } finally {
    removeBusy.value = false;
  }
}
</script>

<template>
  <div v-if="!settings && !notFound"><TfSkeleton :lines="6" /></div>
  <EmptyState
    v-else-if="!settings"
    icon="folder"
    title="프로젝트를 찾을 수 없습니다"
    desc="주소가 잘못되었거나 이 프로젝트의 멤버가 아닙니다."
  >
    <RouterLink class="btn btn-secondary" to="/projects">프로젝트 목록으로</RouterLink>
  </EmptyState>
  <template v-else>
    <div class="page-header">
      <div>
        <div class="breadcrumb">
          <RouterLink :to="`/projects/${settings.projectKey}`">{{ settings.projectNm }}</RouterLink
          ><span>›</span><span>프로젝트</span><span>›</span><span>설정</span>
        </div>
        <h1 class="page-title">
          <span class="project-key">{{ settings.projectKey }}</span
          >{{ isTemplate ? '템플릿' : '프로젝트' }} 설정
        </h1>
        <p class="page-desc">
          이름·설명, 멤버와 프로젝트 역할, 기본값(DDL 방언·기본컬럼 세트)을 관리합니다. 프로젝트
          관리자와 시스템 관리자만 바꿀 수 있습니다. 업무구분은
          <RouterLink :to="`/projects/${settings.projectKey}/biz-areas`"
            >프로젝트 › 업무구분</RouterLink
          >에서 관리합니다.
        </p>
      </div>
    </div>
    <div v-if="archived" class="alert alert-info mb-4" role="status">
      <TfIcon name="lock" />
      <div class="alert-body">
        보관된 {{ isTemplate ? '템플릿' : '프로젝트' }} — 읽기 전용입니다. 복원은 아래 수명주기에서
        시스템 관리자가 합니다.
      </div>
    </div>

    <div class="tabs" role="tablist">
      <button
        v-for="t in TABS.filter((x) => !(isTemplate && x.id === 'members'))"
        :key="t.id"
        :class="['tab', { 'is-active': tab === t.id }]"
        type="button"
        role="tab"
        :aria-selected="tab === t.id"
        @click="tab = t.id"
      >
        <TfIcon :name="t.icon" />{{ t.label }}
        <span v-if="t.id === 'members'" class="count-pill">{{ members.length }}</span>
      </button>
    </div>

    <!-- 기본 정보 -->
    <div v-if="tab === 'basic'" class="tab-panel is-active" role="tabpanel">
      <div class="card mb-4">
        <div class="form-grid">
          <label class="field-label" for="s-name">이름 <span class="req">*</span></label>
          <div class="field-inline">
            <input
              id="s-name"
              v-model="form.projectNm"
              class="input w-320"
              maxlength="100"
              :disabled="!canWrite"
            />
          </div>
          <label class="field-label" for="s-key">키</label>
          <div class="field-inline">
            <input id="s-key" class="input mono w-120" :value="settings.projectKey" disabled />
            <span class="field-help"
              ><TfIcon name="lock" size="sm" /> 키는 URL(<span class="mono"
                >/projects/{{ settings.projectKey }}</span
              >)·식별용이라 생성 후 바꿀 수 없습니다. 테이블 접두어는 업무구분이 정합니다(A4).</span
            >
          </div>
          <label class="field-label" for="s-desc">설명</label>
          <div class="field-inline">
            <textarea
              id="s-desc"
              v-model="form.description"
              class="textarea"
              maxlength="4000"
              :disabled="!canWrite"
            />
          </div>
          <span class="field-label">표준 출처</span>
          <div class="field-inline">
            <span class="text-2"
              >{{ settings.copiedFrom ? `${settings.copiedFrom.nm} · ` : ''
              }}{{ settings.createdAt.slice(0, 10) }} 생성(스냅샷) · {{ settings.createdBy }}</span
            >
            <span v-if="copySummary" class="field-help" data-testid="copy-summary"
              >복사 로그: {{ copySummary.text }} · {{ copySummary.seconds }}초. 원본 변경은 자동
              반영되지 않습니다(C1).</span
            >
          </div>
        </div>
        <div class="row mt-6">
          <TfButton
            variant="primary"
            :disabled="!canWrite || !form.projectNm.trim()"
            :loading="saving"
            @click="save('기본 정보')"
            >저장</TfButton
          >
          <TfButton variant="ghost" :disabled="!canWrite" @click="fill(settings)"
            >되돌리기</TfButton
          >
        </div>
      </div>

      <div class="card" aria-label="수명주기">
        <div class="card-title mb-3"><TfIcon name="clock" />수명주기</div>
        <div class="row wrap">
          <TfButton
            v-if="!archived"
            icon="lock"
            :disabled="!session.isSysAdmin"
            :loading="lifecycleBusy"
            :title="session.isSysAdmin ? '보관하면 읽기 전용이 됩니다' : '시스템 관리자 전용'"
            @click="setStatus('ARCHIVED')"
            >보관</TfButton
          >
          <TfButton
            v-else
            icon="unlock"
            :disabled="!session.isSysAdmin"
            :loading="lifecycleBusy"
            @click="setStatus('ACTIVE')"
            >복원</TfButton
          >
          <TfButton
            v-if="session.isSysAdmin"
            variant="danger-ghost"
            icon="trash"
            :disabled="!isTemplate && !archived"
            :title="!isTemplate && !archived ? '보관된 프로젝트만 삭제할 수 있습니다' : ''"
            @click="((deleting = true), (confirmKey = ''))"
            >{{ isTemplate ? '템플릿' : '프로젝트' }} 삭제</TfButton
          >
          <span v-if="!session.isSysAdmin" class="text-sm text-muted" data-testid="archive-hint"
            ><TfIcon name="info" size="sm" /> 보관·복원·삭제는 시스템 관리자에게 요청하세요.</span
          >
          <span v-else class="text-sm text-muted"
            >보관하면 모든 쓰기가 막히고 목록에서 숨겨집니다. 삭제는 보관 후 키를 다시 입력해야
            합니다.</span
          >
        </div>
      </div>
    </div>

    <!-- 멤버 -->
    <div v-else-if="tab === 'members'" class="tab-panel is-active" role="tabpanel">
      <div v-if="canWrite" class="card mb-4">
        <div class="card-header">
          <div class="card-title"><TfIcon name="plus" />멤버 추가</div>
        </div>
        <div class="row wrap">
          <div class="dropdown w-320">
            <div class="input-wrap">
              <TfIcon name="search" /><input
                v-model="q"
                class="input"
                placeholder="이름 · 아이디"
                aria-label="사용자 검색"
                autocomplete="off"
              />
            </div>
            <div
              v-if="hits.length"
              class="dropdown-menu is-open w-320"
              role="listbox"
              aria-label="계정 검색 결과"
            >
              <div class="dropdown-label">계정 검색 결과 {{ hits.length }}</div>
              <button
                v-for="c in hits"
                :key="c.userId"
                :class="['dropdown-item', { 'is-disabled': c.isMember }]"
                type="button"
                role="option"
                :disabled="c.isMember"
                @click="choose(c)"
              >
                <span class="avatar sm">{{ c.userNm.slice(0, 1) }}</span
                ><span
                  >{{ c.userNm }} <span class="text-muted">{{ c.loginId }}</span></span
                >
                <span class="dropdown-meta">{{ c.isMember ? '이미 멤버' : '미소속' }}</span>
              </button>
              <div class="dropdown-sep" />
              <div class="dropdown-label">
                없는 사용자는 시스템 › 사용자에서 계정을 먼저 만드세요
              </div>
            </div>
          </div>
          <select v-model="addRole" class="select w-160" aria-label="역할">
            <option v-for="r in ['ADMIN', 'EDITOR', 'VIEWER'] as const" :key="r" :value="r">
              {{ ROLE_LABEL[r] }}
            </option>
          </select>
          <TfButton variant="primary" :disabled="!pick" :loading="adding" @click="add"
            >추가</TfButton
          >
        </div>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>이름</th>
              <th>아이디</th>
              <th class="w-160">프로젝트 역할</th>
              <th>추가일</th>
              <th>최근 로그인</th>
              <th class="col-menu" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in members" :key="m.userId" :class="{ 'is-disabled': !m.isActive }">
              <td>
                <span class="row"
                  ><span class="avatar sm">{{ m.userNm.slice(0, 1) }}</span
                  >{{ m.userNm }}</span
                >
              </td>
              <td class="mono">{{ m.loginId }}</td>
              <td>
                <select
                  :value="m.role"
                  class="select select-sm"
                  :aria-label="`${m.userNm} 역할`"
                  :disabled="!canWrite"
                  @change="changeRole(m, ($event.target as HTMLSelectElement).value as MemberRole)"
                >
                  <option v-for="r in ['ADMIN', 'EDITOR', 'VIEWER'] as const" :key="r" :value="r">
                    {{ ROLE_LABEL[r] }}
                  </option>
                </select>
                <TfBadge v-if="m.isSysAdmin" kind="purple">시스템 관리자</TfBadge>
              </td>
              <td class="text-muted">{{ m.addedAt.slice(0, 10) }}</td>
              <td class="text-muted">{{ shortDateTime(m.lastLoginAt) }}</td>
              <td class="col-menu">
                <TfButton
                  v-if="canWrite"
                  variant="ghost"
                  size="sm"
                  icon="x"
                  icon-only
                  :title="`${m.userNm} 멤버 제외`"
                  :aria-label="`${m.userNm} 멤버 제외`"
                  @click="removing = m"
                />
              </td>
            </tr>
            <tr v-if="!loadingMembers && members.length === 0">
              <td colspan="6"><EmptyState in-table icon="users" title="멤버가 없습니다" /></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="text-sm text-muted mt-2">
        역할 변경은 즉시 저장됩니다. 프로젝트 관리자: 설정·업무구분·멤버, 표준 사전 편집·승인 ·
        편집자: 테이블·컬럼 편집, 용어 인라인 등록(검토대기) · 조회자: 조회·DDL 복사/다운로드.
        프로젝트 관리자는 최소 1명이어야 합니다. 시스템 관리자는 멤버가 아니어도 모든 프로젝트의
        관리자 권한을 가집니다.
      </p>
    </div>

    <!-- 기본값 -->
    <div v-else class="tab-panel is-active" role="tabpanel">
      <div class="card mb-4">
        <div class="card-title mb-3"><TfIcon name="code" />DDL 기본값</div>
        <div class="form-grid">
          <label class="field-label" for="s-dialect">기본 방언</label>
          <div class="field-inline">
            <select
              id="s-dialect"
              v-model="form.defaultDialect"
              class="select w-240"
              :disabled="!canWrite"
            >
              <option value="POSTGRESQL">PostgreSQL</option>
            </select>
            <span class="field-help"
              >편집기 DDL 패널과 내보내기의 기본값. 내보낼 때마다 바꿀 수 있습니다.</span
            >
          </div>
        </div>
      </div>
      <div class="section-title"><TfIcon name="columns" />기본컬럼 세트</div>
      <div class="card mb-4">
        <div class="row wrap">
          <TfToggle
            v-model="form.includeDefaultCols"
            :disabled="!canWrite"
            aria-label="새 테이블에 기본컬럼 자동 포함"
            ><strong>새 테이블에 기본컬럼 자동 포함</strong></TfToggle
          >
          <span class="text-muted">세트</span>
          <select
            v-model="form.defaultColSetId"
            class="select w-160"
            aria-label="기본컬럼 세트"
            :disabled="!canWrite"
          >
            <option :value="null">(없음)</option>
            <option v-for="s in settings.defaultColSets" :key="s.setId" :value="s.setId">
              {{ s.setNm }} ({{ s.columns.length }}개)
            </option>
          </select>
          <span class="text-sm text-muted"
            >MVP는 단일 세트(D10). 세트 내용은 표준 사전 › 기본컬럼에서 관리합니다.</span
          >
        </div>
      </div>
      <div v-if="selectedSet" class="table-wrap">
        <table class="table table-compact">
          <thead>
            <tr>
              <th class="num">순서</th>
              <th>논리명</th>
              <th>물리명</th>
              <th>타입</th>
              <th>기본값</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in selectedSet.columns" :key="c.colSeq">
              <td class="num">{{ c.colSeq }}</td>
              <td>{{ c.logicalNm }}</td>
              <td class="mono">{{ c.physicalNm }}</td>
              <td class="mono">{{ c.typeText }}</td>
              <td class="mono">{{ c.defaultVal ?? '' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="row mt-4">
        <TfButton variant="primary" :disabled="!canWrite" :loading="saving" @click="save('기본값')"
          >저장</TfButton
        >
        <span class="text-sm text-muted">기존 테이블에는 영향이 없습니다.</span>
      </div>
    </div>

    <ConfirmDeleteModal
      :open="removing !== null"
      :title="`${removing?.userNm} 님을 멤버에서 제외할까요?`"
      confirm-label="제외"
      :busy="removeBusy"
      @cancel="removing = null"
      @confirm="removeMember"
    >
      <strong>{{ removing?.userNm }}</strong> 님은 이 프로젝트를 더 이상 볼 수 없습니다. 작성한
      테이블·이력은 그대로 남습니다.
    </ConfirmDeleteModal>
    <ConfirmDeleteModal
      :open="deleting"
      :title="`${isTemplate ? '템플릿' : '프로젝트'} '${settings.projectNm}'을(를) 삭제할까요?`"
      :busy="deleteBusy"
      :confirm-disabled="confirmKey !== settings.projectKey"
      @cancel="deleting = false"
      @confirm="remove"
    >
      이 {{ isTemplate ? '템플릿' : '프로젝트' }}의 업무구분·표준 사전·테이블·변경이력이 모두
      삭제됩니다. 다른 프로젝트에는 영향이 없습니다. 확인을 위해 키
      <strong class="mono">{{ settings.projectKey }}</strong
      >를 입력하세요.
      <input
        v-model="confirmKey"
        class="input mono mt-3 w-120"
        :placeholder="settings.projectKey"
        aria-label="확인용 키"
      />
    </ConfirmDeleteModal>
  </template>
</template>
