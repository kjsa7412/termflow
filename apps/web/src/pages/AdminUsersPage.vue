<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  PASSWORD_POLICY,
  type AdminUserItem,
  type AdminUserPage,
  type UserStatusFilter,
  type ValidationIssue,
} from '@termflow/shared';
import { ApiError } from '../api/client.js';
import { usersApi } from '../api/users.js';
import { ROLE_LABEL, shortDateTime } from '../components/layout/labels.js';
import ConfirmDeleteModal from '../components/ui/ConfirmDeleteModal.vue';
import DataTable from '../components/ui/DataTable.vue';
import type { Column, Sort } from '../components/ui/data-table.js';
import EmptyState from '../components/ui/EmptyState.vue';
import TfBadge from '../components/ui/TfBadge.vue';
import TfButton from '../components/ui/TfButton.vue';
import TfCheckbox from '../components/ui/TfCheckbox.vue';
import TfIcon from '../components/ui/TfIcon.vue';
import TfPopover from '../components/ui/TfPopover.vue';
import TfToggle from '../components/ui/TfToggle.vue';
import { copyText } from '../composables/clipboard.js';
import { useSessionStore } from '../stores/session.js';
import { useToastStore } from '../stores/toast.js';

/**
 * 사용자 관리(목업 13_users, §10.1 `/admin/users`, 시스템 관리자). 계정 생성은 인라인 입력행 → 서버가 만든
 * 초기 비밀번호를 **이 화면에서 한 번만** 표시(복사 후 닫으면 다시 볼 수 없음). 비밀번호 초기화도 같은 방식.
 */
const api = usersApi();
const session = useSessionStore();
const toast = useToastStore();

const data = ref<AdminUserPage | null>(null);
const loading = ref(true);
const q = ref('');
const status = ref<UserStatusFilter>('ALL');
const sysAdminOnly = ref(false);
const page = ref(1);
const size = ref(20);
const sort = ref<Sort | null>({ key: 'userNm', dir: 'asc' });

const columns: Column[] = [
  { key: 'userNm', label: '이름', sortable: true },
  { key: 'loginId', label: '아이디', sortable: true },
  { key: 'email', label: '이메일' },
  { key: 'isSysAdmin', label: '시스템 관리자' },
  { key: 'projects', label: '프로젝트 · 역할', class: 'col-text' },
  { key: 'status', label: '상태', class: 'col-status' },
  { key: 'lastLoginAt', label: '최근 로그인', class: 'nowrap' },
  { key: 'menu', label: '', class: 'col-menu' },
];
const segments: { value: UserStatusFilter; label: string; count: (d: AdminUserPage) => number }[] =
  [
    { value: 'ALL', label: '전체', count: (d) => d.counts.all },
    { value: 'ACTIVE', label: '활성', count: (d) => d.counts.active },
    { value: 'PW_PENDING', label: '변경 대기', count: (d) => d.counts.pwPending },
    { value: 'LOCKED', label: '잠김', count: (d) => d.counts.locked },
    { value: 'INACTIVE', label: '비활성', count: (d) => d.counts.inactive },
  ];

async function load(): Promise<void> {
  loading.value = true;
  try {
    data.value = await api.list({
      q: q.value.trim() || undefined,
      status: status.value,
      sysAdmin: sysAdminOnly.value,
      page: page.value,
      size: size.value,
    });
  } catch {
    toast.error('사용자 목록을 불러오지 못했습니다');
  } finally {
    loading.value = false;
  }
}
onMounted(load);
let debounce: ReturnType<typeof setTimeout> | undefined;
watch(q, () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    page.value = 1;
    void load();
  }, 300);
});
watch([status, sysAdminOnly], () => {
  page.value = 1;
  void load();
});
watch([page, size], () => void load());

// ── 초기 비밀번호 1회 표시 ─────────────────────────────────────
const issued = ref<{
  userNm: string;
  loginId: string;
  password: string;
  reason: 'create' | 'reset';
} | null>(null);
async function copyIssued(): Promise<void> {
  if (!issued.value) return;
  if (await copyText(issued.value.password)) toast.success('초기 비밀번호를 복사했습니다');
  else toast.error('복사하지 못했습니다. 직접 선택해 복사하세요');
}

// ── 계정 생성(인라인 행) ───────────────────────────────────────
const creating = ref(false);
const draft = ref({ userNm: '', loginId: '', email: '', isSysAdmin: false });
const createErrors = ref<ValidationIssue[]>([]);
const createBusy = ref(false);
function openCreate(): void {
  creating.value = !creating.value;
  draft.value = { userNm: '', loginId: '', email: '', isSysAdmin: false };
  createErrors.value = [];
}
const fieldError = (field: string) => createErrors.value.find((e) => e.field === field)?.message;
const canCreate = computed(
  () =>
    draft.value.userNm.trim() !== '' &&
    /^\S+$/.test(draft.value.loginId.trim()) &&
    !createBusy.value,
);
async function create(): Promise<void> {
  if (!canCreate.value) return;
  createBusy.value = true;
  createErrors.value = [];
  try {
    const res = await api.create({
      userNm: draft.value.userNm.trim(),
      loginId: draft.value.loginId.trim(),
      email: draft.value.email.trim() || null,
      isSysAdmin: draft.value.isSysAdmin,
    });
    if (res.temporaryPassword) {
      issued.value = {
        userNm: res.user.userNm,
        loginId: res.user.loginId,
        password: res.temporaryPassword,
        reason: 'create',
      };
    }
    creating.value = false;
    toast.success(`${res.user.userNm}(${res.user.loginId}) 계정을 만들었습니다`);
    await load();
  } catch (e) {
    if (e instanceof ApiError && e.code === 'E_LOGIN_ID_DUP') {
      createErrors.value = [
        {
          code: e.code,
          field: 'loginId',
          message: `아이디 '${draft.value.loginId.trim()}'는 이미 사용 중입니다`,
        },
      ];
    } else if (e instanceof ApiError && (e.status === 400 || e.status === 422)) {
      createErrors.value = (e.problem?.['errors'] as ValidationIssue[] | undefined) ?? [];
    } else {
      toast.error('계정을 만들지 못했습니다');
    }
  } finally {
    createBusy.value = false;
  }
}

// ── 수정(인라인 편집) ──────────────────────────────────────────
const editingId = ref<number | null>(null);
const edit = ref({ userNm: '', email: '', isSysAdmin: false });
function startEdit(u: AdminUserItem): void {
  editingId.value = u.id;
  edit.value = { userNm: u.userNm, email: u.email ?? '', isSysAdmin: u.isSysAdmin };
}
async function saveEdit(u: AdminUserItem): Promise<void> {
  try {
    await api.update(u.id, {
      userNm: edit.value.userNm.trim(),
      email: edit.value.email.trim() || null,
      isSysAdmin: edit.value.isSysAdmin,
    });
    editingId.value = null;
    toast.success('저장했습니다');
    if (u.id === session.user?.id) await session.refresh();
    await load();
  } catch (e) {
    toast.error(
      e instanceof ApiError && e.problem?.detail ? e.problem.detail : '저장하지 못했습니다',
    );
  }
}

// ── 비밀번호 초기화·잠금 해제·활성 ─────────────────────────────
async function resetPassword(u: AdminUserItem): Promise<void> {
  try {
    const r = await api.resetPassword(u.id);
    issued.value = {
      userNm: u.userNm,
      loginId: u.loginId,
      password: r.temporaryPassword,
      reason: 'reset',
    };
    await load();
  } catch {
    toast.error('비밀번호를 초기화하지 못했습니다');
  }
}
async function unlock(u: AdminUserItem): Promise<void> {
  try {
    await api.unlock(u.id);
    toast.success(`${u.userNm} 계정의 잠금을 해제했습니다`);
    await load();
  } catch {
    toast.error('잠금을 해제하지 못했습니다');
  }
}
const deactivating = ref<AdminUserItem | null>(null);
const activeBusy = ref(false);
async function setActive(u: AdminUserItem, isActive: boolean): Promise<void> {
  activeBusy.value = true;
  try {
    await api.setActive(u.id, isActive);
    toast.success(
      isActive ? `${u.userNm} 계정을 활성화했습니다` : `${u.userNm} 계정을 비활성화했습니다`,
    );
    deactivating.value = null;
    await load();
  } catch (e) {
    toast.error(
      e instanceof ApiError && e.problem?.detail ? e.problem.detail : '처리하지 못했습니다',
    );
  } finally {
    activeBusy.value = false;
  }
}

const rowClass = (u: AdminUserItem) => ({
  'is-disabled': !u.isActive || u.locked,
  'is-editing': editingId.value === u.id,
});
const rows = computed(
  () => (data.value?.items ?? []) as (AdminUserItem & Record<string, unknown>)[],
);
</script>

<template>
  <div class="page-header">
    <div>
      <div class="breadcrumb"><span>시스템</span><span>›</span><span>사용자</span></div>
      <h1 class="page-title">
        사용자 <span class="count-pill">{{ data?.counts.all ?? 0 }}</span>
      </h1>
      <p class="page-desc">
        계정은 시스템 관리자만 만듭니다(자가 가입 없음). 계정은 전사 공통이고, 프로젝트
        역할(프로젝트 관리자·편집자·조회자)은 각 프로젝트 설정 › 멤버에서 부여합니다. 생성 시 초기
        비밀번호가 한 번만 표시되며, 사용자는 최초 로그인에서 비밀번호를 바꿔야 합니다. 비밀번호 5회
        실패 시 자동 잠금.
      </p>
    </div>
    <div class="page-actions">
      <TfButton variant="primary" icon="plus" :aria-expanded="creating" @click="openCreate"
        >계정 생성</TfButton
      >
    </div>
  </div>

  <div class="toolbar">
    <div class="input-wrap w-320">
      <TfIcon name="search" />
      <input
        v-model="q"
        class="input"
        type="search"
        placeholder="이름 · 아이디 · 이메일 검색"
        aria-label="사용자 검색"
      />
    </div>
    <div class="seg" role="group" aria-label="상태 필터">
      <button
        v-for="s in segments"
        :key="s.value"
        type="button"
        :class="{ 'is-active': status === s.value }"
        :aria-pressed="status === s.value"
        @click="status = s.value"
      >
        {{ s.label }} <span class="count">{{ data ? s.count(data) : 0 }}</span>
      </button>
    </div>
    <TfCheckbox v-model="sysAdminOnly">
      시스템 관리자만 <span class="text-muted">({{ data?.counts.sysAdmin ?? 0 }})</span>
    </TfCheckbox>
  </div>

  <div v-if="issued" class="alert alert-success mb-4" role="status">
    <TfIcon name="key" />
    <div class="alert-body">
      <div class="alert-title">
        {{ issued.userNm }}({{ issued.loginId }})
        {{ issued.reason === 'create' ? '계정을 만들었습니다' : '비밀번호를 초기화했습니다' }} —
        초기 비밀번호는 지금 한 번만 표시됩니다
      </div>
      <div class="row mt-2">
        <code class="badge badge-outline mono badge-lg" data-testid="issued-password">{{
          issued.password
        }}</code>
        <span class="text-sm">
          복사해 본인에게 직접 전달하세요. 최초 로그인 시 변경이 강제됩니다. 이 창을 닫으면 다시 볼
          수 없습니다.
        </span>
      </div>
    </div>
    <div class="alert-actions">
      <TfButton size="sm" icon="copy" @click="copyIssued">복사</TfButton>
      <TfButton
        size="sm"
        variant="ghost"
        icon="x"
        icon-only
        title="닫기"
        aria-label="닫기"
        @click="issued = null"
      />
    </div>
  </div>

  <DataTable
    v-model:sort="sort"
    v-model:page="page"
    v-model:size="size"
    :columns="columns"
    :rows="rows"
    row-key="id"
    local-sort
    :total="data?.total ?? 0"
    :loading="loading && !data"
    :row-class="rowClass"
    caption="사용자 목록"
  >
    <template #prepend>
      <template v-if="creating">
        <tr class="is-inline-new">
          <td>
            <input
              v-model="draft.userNm"
              class="input"
              aria-label="이름"
              placeholder="이름"
              maxlength="100"
            />
          </td>
          <td>
            <input
              v-model="draft.loginId"
              :class="['input', 'mono', 'w-120', { 'is-invalid': !!fieldError('loginId') }]"
              aria-label="아이디"
              placeholder="아이디"
              maxlength="50"
              autocomplete="off"
            />
          </td>
          <td>
            <input
              v-model="draft.email"
              class="input"
              type="email"
              aria-label="이메일"
              placeholder="(선택)"
              maxlength="100"
            />
          </td>
          <td>
            <TfToggle
              v-model="draft.isSysAdmin"
              aria-label="시스템 관리자"
              title="시스템 관리자: 사용자·템플릿·프로젝트 생성 관리"
            />
          </td>
          <td class="text-muted text-sm">프로젝트 설정 › 멤버에서 지정</td>
          <td colspan="3" class="nowrap">
            <TfButton
              variant="primary"
              size="sm"
              :disabled="!canCreate"
              :loading="createBusy"
              @click="create"
            >
              생성 · 초기 비밀번호 발급
            </TfButton>
            {{ ' ' }}
            <TfButton variant="ghost" size="sm" @click="creating = false">취소</TfButton>
          </td>
        </tr>
        <tr class="row-msg">
          <td colspan="8">
            <div class="row wrap text-sm">
              <span v-for="e in createErrors" :key="e.field + e.code" class="text-danger">
                <TfIcon name="alert-circle" size="sm" /> {{ e.message }}
              </span>
              <span class="text-muted">· 아이디는 공백 없이 50자 이내 · 이메일은 선택</span>
            </div>
          </td>
        </tr>
      </template>
    </template>

    <template #cell-userNm="{ row }">
      <input
        v-if="editingId === row.id"
        v-model="edit.userNm"
        class="input"
        aria-label="이름"
        maxlength="100"
      />
      <span v-else class="row"
        ><span class="avatar sm" aria-hidden="true">{{ row.userNm.slice(0, 1) }}</span
        >{{ row.userNm }}</span
      >
    </template>
    <template #cell-loginId="{ row }"
      ><span class="mono">{{ row.loginId }}</span></template
    >
    <template #cell-email="{ row }">
      <input
        v-if="editingId === row.id"
        v-model="edit.email"
        class="input"
        type="email"
        aria-label="이메일"
        maxlength="100"
      />
      <span v-else :class="row.email ? 'text-2' : 'text-muted'">{{ row.email ?? '—' }}</span>
    </template>
    <template #cell-isSysAdmin="{ row }">
      <TfToggle v-if="editingId === row.id" v-model="edit.isSysAdmin" aria-label="시스템 관리자" />
      <TfBadge v-else-if="row.isSysAdmin" kind="purple" icon="shield">시스템 관리자</TfBadge>
      <span v-else class="text-muted">—</span>
    </template>
    <template #cell-projects="{ row }">
      <span v-if="row.isSysAdmin" class="text-2">
        전체 프로젝트(시스템 관리자){{ row.projects.length ? ' · ' : ''
        }}{{ row.projects.map((p) => `${p.key} ${ROLE_LABEL[p.role]}`).join(' · ') }}
      </span>
      <span v-else-if="row.projects.length" class="text-2">
        {{ row.projects.map((p) => `${p.key} ${ROLE_LABEL[p.role]}`).join(' · ') }}
      </span>
      <span v-else class="text-muted">(미지정)</span>
    </template>
    <template #cell-status="{ row }">
      <TfBadge v-if="!row.isActive" kind="draft">비활성</TfBadge>
      <template v-else-if="row.locked">
        <TfBadge kind="rejected" icon="lock">잠김</TfBadge>
        <span class="sub">비밀번호 {{ PASSWORD_POLICY.lockoutMaxFailures }}회 실패</span>
      </template>
      <TfBadge v-else-if="row.pwChangeRequired" kind="pending">비밀번호 변경 대기</TfBadge>
      <TfBadge v-else kind="approved">활성</TfBadge>
    </template>
    <template #cell-lastLoginAt="{ row }"
      ><span class="text-muted">{{ shortDateTime(row.lastLoginAt) }}</span></template
    >
    <template #cell-menu="{ row }">
      <span v-if="editingId === row.id" class="nowrap">
        <TfButton variant="primary" size="sm" @click="saveEdit(row)">저장</TfButton>
        <TfButton variant="ghost" size="sm" @click="editingId = null">취소</TfButton>
      </span>
      <TfButton v-else-if="row.isActive && row.locked" size="sm" icon="unlock" @click="unlock(row)"
        >해제</TfButton
      >
      <TfPopover v-else align="right">
        <template #trigger="{ toggle, open, menuId }">
          <button
            class="btn btn-ghost btn-sm btn-icon"
            type="button"
            :aria-label="`${row.userNm} 행 메뉴`"
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
            class="dropdown-item"
            type="button"
            role="menuitem"
            @click="(close(), startEdit(row))"
          >
            <TfIcon name="edit" />수정
          </button>
          <button
            class="dropdown-item"
            type="button"
            role="menuitem"
            @click="(close(), resetPassword(row))"
          >
            <TfIcon name="key" />{{
              row.pwChangeRequired ? '초기 비밀번호 재발급' : '비밀번호 초기화'
            }}
          </button>
          <div class="dropdown-sep" />
          <button
            v-if="row.isActive"
            class="dropdown-item is-danger"
            type="button"
            role="menuitem"
            :disabled="row.id === session.user?.id"
            @click="(close(), (deactivating = row))"
          >
            <TfIcon name="lock" />비활성화
          </button>
          <button
            v-else
            class="dropdown-item"
            type="button"
            role="menuitem"
            @click="(close(), setActive(row, true))"
          >
            <TfIcon name="unlock" />활성화
          </button>
        </template>
      </TfPopover>
    </template>

    <template #empty>
      <EmptyState
        in-table
        icon="users"
        title="조건에 맞는 사용자가 없습니다"
        desc="검색어나 상태 필터를 바꿔 보세요."
      />
    </template>
  </DataTable>
  <p class="text-sm text-muted mt-2">
    감사컬럼(created_by 등)에는 로그인 아이디가 기록됩니다. 기록이 남은 계정은 삭제 대신
    비활성화합니다.
  </p>

  <ConfirmDeleteModal
    :open="deactivating !== null"
    :title="`${deactivating?.userNm}(${deactivating?.loginId}) 계정을 비활성화할까요?`"
    confirm-label="비활성화"
    :busy="activeBusy"
    @cancel="deactivating = null"
    @confirm="deactivating && setActive(deactivating, false)"
  >
    비활성화하면 이 사용자는 바로 로그아웃되고 다시 로그인할 수 없습니다. 작성 기록의 아이디는
    남으며, 나중에 활성화하면 되살릴 수 있습니다.
  </ConfirmDeleteModal>
</template>
