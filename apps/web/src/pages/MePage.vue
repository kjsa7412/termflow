<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  PASSWORD_POLICY,
  PASSWORD_VIOLATION_MESSAGES,
  checkPasswordPolicy,
  type ValidationIssue,
} from '@termflow/shared';
import { ApiError } from '../api/client.js';
import { ROLE_LABEL } from '../components/layout/labels.js';
import TfBadge from '../components/ui/TfBadge.vue';
import TfButton from '../components/ui/TfButton.vue';
import TfIcon from '../components/ui/TfIcon.vue';
import TfInput from '../components/ui/TfInput.vue';
import { useSessionStore } from '../stores/session.js';
import { useToastStore } from '../stores/toast.js';

/**
 * 내 계정(`/me`, §10.1). `?forcePassword=1`이면 강제 변경 모드(목업 01_login 상태 3, 가운데 카드):
 * 변경하기 전에는 다른 화면으로 갈 수 없다(라우트 가드·서버 PasswordChangeGuard). 평소에는 앱 셸 안의 계정 정보 + 변경 폼.
 */
const session = useSessionStore();
const toast = useToastStore();
const route = useRoute();
const router = useRouter();
const force = computed(() => route.query['forcePassword'] === '1');

const current = ref('');
const next = ref('');
const confirm = ref('');
const busy = ref(false);
const serverErrors = ref<ValidationIssue[]>([]);

const violations = computed(() =>
  next.value === '' ? [] : checkPasswordPolicy(next.value, session.user?.loginId ?? ''),
);
const policyText = `${PASSWORD_POLICY.minLength}자 이상 · 영문/숫자/기호 중 ${PASSWORD_POLICY.minCharClasses}종 이상 · 아이디 미포함`;
const newError = computed(() => {
  const s = serverErrors.value.find((e) => e.field === 'newPassword');
  if (s) return s.message;
  const v = violations.value[0];
  return v ? PASSWORD_VIOLATION_MESSAGES[v] : null;
});
const currentError = computed(
  () => serverErrors.value.find((e) => e.field === 'currentPassword')?.message ?? null,
);
const confirmError = computed(() =>
  confirm.value !== '' && confirm.value !== next.value ? '새 비밀번호와 일치하지 않습니다' : null,
);
const canSubmit = computed(
  () =>
    current.value !== '' &&
    next.value !== '' &&
    violations.value.length === 0 &&
    confirm.value === next.value &&
    !busy.value,
);

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  busy.value = true;
  serverErrors.value = [];
  try {
    await session.changePassword(current.value, next.value);
    current.value = next.value = confirm.value = '';
    toast.success('비밀번호를 변경했습니다');
    if (force.value) await router.replace('/projects');
  } catch (e) {
    if (e instanceof ApiError && e.status === 422) {
      serverErrors.value = (e.problem?.['errors'] as ValidationIssue[] | undefined) ?? [];
    } else if (e instanceof ApiError && e.status === 400) {
      serverErrors.value = [
        {
          code: 'E_FORMAT',
          field: 'newPassword',
          message: `비밀번호는 ${PASSWORD_POLICY.maxLength}자 이하입니다`,
        },
      ];
    } else {
      toast.error('비밀번호를 변경하지 못했습니다. 잠시 후 다시 시도하세요');
    }
  } finally {
    busy.value = false;
  }
}

async function logout(): Promise<void> {
  await session.logout();
  await router.replace('/login');
}
</script>

<template>
  <!-- 강제 변경 모드(가운데 카드) -->
  <div v-if="force" class="card auth-card">
    <div class="auth-brand">
      <span class="brand-mark lg">TF</span>
      <h1 class="name">비밀번호 변경</h1>
      <div class="tag">{{ session.user?.userNm }} 님, 새 비밀번호를 정해 주세요</div>
    </div>
    <form class="stack" novalidate @submit.prevent="submit">
      <div class="alert alert-info">
        <TfIcon name="info" />
        <div class="alert-body">
          관리자가 발급한 <strong>초기 비밀번호</strong>는 한 번만 쓸 수 있습니다. 새 비밀번호로
          변경해야 계속할 수 있습니다.
        </div>
      </div>
      <TfInput
        id="pw-current"
        v-model="current"
        type="password"
        label="초기 비밀번호"
        autocomplete="current-password"
        :error="currentError"
        :maxlength="PASSWORD_POLICY.maxLength"
        autofocus
      />
      <TfInput
        id="pw-new"
        v-model="next"
        type="password"
        label="새 비밀번호"
        autocomplete="new-password"
        :error="newError"
        :help="policyText"
        :valid="next !== '' && violations.length === 0"
        :maxlength="PASSWORD_POLICY.maxLength"
      />
      <TfInput
        id="pw-confirm"
        v-model="confirm"
        type="password"
        label="새 비밀번호 확인"
        autocomplete="new-password"
        :error="confirmError"
        :maxlength="PASSWORD_POLICY.maxLength"
      />
      <TfButton type="submit" variant="primary" block :disabled="!canSubmit" :loading="busy">
        변경하고 시작
      </TfButton>
      <TfButton variant="ghost" block @click="logout">로그아웃</TfButton>
    </form>
  </div>

  <!-- 일반 모드(앱 셸) -->
  <template v-else>
    <div class="page-header">
      <div>
        <div class="breadcrumb"><span>내 계정</span></div>
        <h1 class="page-title">내 계정</h1>
        <p class="page-desc">이름·소속 프로젝트·역할을 확인하고 비밀번호를 바꿉니다.</p>
      </div>
    </div>
    <div class="grid-2">
      <section class="card" aria-labelledby="me-info">
        <div class="card-header">
          <h2 id="me-info" class="card-title"><TfIcon name="user" />계정</h2>
        </div>
        <div class="form-grid">
          <span class="field-label">이름</span><span>{{ session.user?.userNm }}</span>
          <span class="field-label">아이디</span
          ><span class="mono">{{ session.user?.loginId }}</span>
          <span class="field-label">권한</span>
          <span>
            <TfBadge v-if="session.isSysAdmin" kind="purple" icon="shield">시스템 관리자</TfBadge>
            <span v-else class="text-muted">일반 사용자</span>
          </span>
          <span class="field-label">프로젝트 · 역할</span>
          <span>
            <span v-if="session.projects.length === 0" class="text-muted">(미지정)</span>
            <span v-else class="stack-sm">
              <span v-for="p in session.projects" :key="p.key" class="row">
                <span class="project-key">{{ p.key }}</span
                >{{ p.nm }}
                <span class="text-muted">· {{ ROLE_LABEL[p.role] }}</span>
              </span>
            </span>
          </span>
        </div>
      </section>
      <section class="card" aria-labelledby="me-pw">
        <div class="card-header">
          <h2 id="me-pw" class="card-title"><TfIcon name="key" />비밀번호 변경</h2>
        </div>
        <form class="stack" novalidate @submit.prevent="submit">
          <TfInput
            id="pw-current"
            v-model="current"
            type="password"
            label="현재 비밀번호"
            autocomplete="current-password"
            :error="currentError"
            :maxlength="PASSWORD_POLICY.maxLength"
          />
          <TfInput
            id="pw-new"
            v-model="next"
            type="password"
            label="새 비밀번호"
            autocomplete="new-password"
            :error="newError"
            :help="policyText"
            :valid="next !== '' && violations.length === 0"
            :maxlength="PASSWORD_POLICY.maxLength"
          />
          <TfInput
            id="pw-confirm"
            v-model="confirm"
            type="password"
            label="새 비밀번호 확인"
            autocomplete="new-password"
            :error="confirmError"
            :maxlength="PASSWORD_POLICY.maxLength"
          />
          <div class="row">
            <span class="spacer" />
            <TfButton type="submit" variant="primary" :disabled="!canSubmit" :loading="busy">
              비밀번호 변경
            </TfButton>
          </div>
        </form>
      </section>
    </div>
  </template>
</template>
