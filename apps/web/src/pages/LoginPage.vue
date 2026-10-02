<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { APP_NAME, PASSWORD_POLICY } from '@termflow/shared';
import { ApiError } from '../api/client.js';
import TfButton from '../components/ui/TfButton.vue';
import TfCheckbox from '../components/ui/TfCheckbox.vue';
import TfIcon from '../components/ui/TfIcon.vue';
import TfInput from '../components/ui/TfInput.vue';
import { safeNext } from '../router.js';
import { useSessionStore } from '../stores/session.js';

/**
 * 로그인(목업 01_login 상태 1·2, §7.1·§7.6). 키보드만으로 완료: Tab 이동, Enter 제출.
 * 401은 계정 존재를 알 수 없게 같은 문구, 423은 서버의 남은 시간 문구를 그대로 보여준다.
 */
const REMEMBER_KEY = 'tf.rememberLoginId';
const session = useSessionStore();
const router = useRouter();
const route = useRoute();

function readRemembered(): string {
  try {
    return localStorage.getItem(REMEMBER_KEY) ?? '';
  } catch {
    return '';
  }
}
const loginId = ref(readRemembered());
const password = ref('');
const remember = ref(loginId.value !== '');
const busy = ref(false);
const error = ref<{ kind: 'invalid' | 'locked' | 'other'; title: string; body: string } | null>(
  null,
);
const form = ref<HTMLFormElement | null>(null);
/** 로그인해 있다가 세션이 끊겨 온 경우(직접 로그아웃 제외) — 왜 로그인 화면인지 알린다(CR-15 C16). */
const expired = ref(session.takeExpired());

function focus(name: 'loginId' | 'password'): void {
  void nextTick(() => form.value?.querySelector<HTMLInputElement>(`[name="${name}"]`)?.focus());
}
onMounted(() => focus(loginId.value ? 'password' : 'loginId'));

async function submit(): Promise<void> {
  if (busy.value) return;
  if (loginId.value.trim() === '' || password.value === '') {
    error.value = { kind: 'invalid', title: '아이디와 비밀번호를 입력하세요', body: '' };
    focus(loginId.value.trim() === '' ? 'loginId' : 'password');
    return;
  }
  busy.value = true;
  error.value = null;
  try {
    await session.login(loginId.value.trim(), password.value);
    try {
      if (remember.value) localStorage.setItem(REMEMBER_KEY, loginId.value.trim());
      else localStorage.removeItem(REMEMBER_KEY);
    } catch {
      /* 저장 불가 환경은 무시 */
    }
    password.value = '';
    await router.replace(
      session.mustChangePassword
        ? { path: '/me', query: { forcePassword: '1' } }
        : safeNext(route.query['next']),
    );
  } catch (e) {
    password.value = '';
    if (e instanceof ApiError && e.status === 423) {
      error.value = { kind: 'locked', title: '계정이 잠겼습니다', body: e.problem?.detail ?? '' };
    } else if (e instanceof ApiError && (e.status === 401 || e.status === 400)) {
      error.value = {
        kind: 'invalid',
        title: '아이디 또는 비밀번호가 올바르지 않습니다',
        body: `${PASSWORD_POLICY.lockoutMaxFailures}회 연속 실패하면 계정이 ${PASSWORD_POLICY.lockoutMinutes}분간 잠깁니다.`,
      };
    } else {
      error.value = {
        kind: 'other',
        title: '서버에 연결할 수 없습니다',
        body: '잠시 후 다시 시도하세요.',
      };
    }
    focus('password');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="card auth-card">
    <div class="auth-brand">
      <span class="brand-mark lg">TF</span>
      <h1 class="name">{{ APP_NAME }}</h1>
      <div class="tag">용어에서 DDL까지, 끊김 없는 한 흐름.</div>
    </div>
    <form ref="form" class="stack" novalidate @submit.prevent="submit">
      <div
        v-if="expired && !error"
        class="alert alert-info"
        role="status"
        data-testid="session-expired"
      >
        <TfIcon name="clock" />
        <div class="alert-body">
          <div class="alert-title">로그인 시간이 끝났습니다</div>
          한동안 작업이 없어 자동으로 로그아웃되었습니다. 다시 로그인하면 보던 화면으로 돌아갑니다.
          편집 중이던 테이블은 브라우저에 임시저장되어 있습니다.
        </div>
      </div>
      <div v-if="error && error.kind !== 'locked'" class="alert alert-danger" role="alert">
        <TfIcon name="alert-circle" />
        <div class="alert-body">
          <div class="alert-title">{{ error.title }}</div>
          {{ error.body }}
        </div>
      </div>
      <div v-if="error?.kind === 'locked'" class="alert alert-warning" role="alert">
        <TfIcon name="lock" />
        <div class="alert-body">
          <div class="alert-title">{{ error.title }}</div>
          {{ error.body }}
        </div>
      </div>
      <TfInput
        id="login-id"
        v-model="loginId"
        name="loginId"
        label="아이디"
        placeholder="사내 아이디"
        autocomplete="username"
        :invalid="error?.kind === 'invalid'"
        :maxlength="50"
      />
      <TfInput
        id="login-pw"
        v-model="password"
        name="password"
        type="password"
        label="비밀번호"
        placeholder="••••••••"
        autocomplete="current-password"
        :error="error?.kind === 'invalid' ? '다시 입력하세요' : null"
        :maxlength="PASSWORD_POLICY.maxLength"
      />
      <TfCheckbox v-model="remember">이 브라우저에서 아이디 기억</TfCheckbox>
      <TfButton type="submit" variant="primary" block :loading="busy" kbd="Enter">로그인</TfButton>
    </form>
    <div class="divider" />
    <p class="auth-foot">
      계정은 관리자가 발급합니다. 비밀번호를 잊었다면 관리자에게 초기화를 요청하세요.
    </p>
    <p class="auth-foot mt-2">
      처음이라면 <RouterLink to="/manual/사용자_가이드">사용자 가이드</RouterLink>를 먼저 읽어
      보세요.
    </p>
  </div>
</template>
