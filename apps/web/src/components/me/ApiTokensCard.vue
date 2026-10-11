<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { API_TOKEN_EXPIRY_DAYS, type ApiTokenItem } from '@termflow/shared';
import { authApi } from '../../api/auth.js';
import { ApiError } from '../../api/client.js';
import { copyText } from '../../composables/clipboard.js';
import { useToastStore } from '../../stores/toast.js';
import ConfirmDeleteModal from '../ui/ConfirmDeleteModal.vue';
import TfBadge from '../ui/TfBadge.vue';
import TfButton from '../ui/TfButton.vue';
import TfIcon from '../ui/TfIcon.vue';
import TfInput from '../ui/TfInput.vue';
import TfSelect from '../ui/TfSelect.vue';

/**
 * 개인 접근 토큰(CR-18 C3·C8) — 에이전트 도구 연동(`/mcp`)용. 원문은 발급 직후 한 번만 보이고,
 * 연결 설정(JSON)을 함께 보여 준다. 서버 설정(TERMFLOW_MCP_ENABLED)이 꺼져 있으면 안내만 한다.
 */
const auth = authApi();
const toast = useToastStore();

const loaded = ref(false);
const enabled = ref(false);
const mcpPath = ref('/mcp');
const items = ref<ApiTokenItem[]>([]);
const tokenNm = ref('');
const days = ref(String(API_TOKEN_EXPIRY_DAYS.default));
const busy = ref(false);
const issued = ref<{ token: string; tokenNm: string } | null>(null);
const revoking = ref<ApiTokenItem | null>(null);
const revokeBusy = ref(false);

const DAY_OPTIONS = [
  { value: '30', label: '30일' },
  { value: '90', label: '90일' },
  { value: '180', label: '180일' },
  { value: String(API_TOKEN_EXPIRY_DAYS.max), label: '1년' },
] as const;
const STATUS: Record<
  ApiTokenItem['status'],
  { kind: 'success' | 'gray' | 'danger'; label: string }
> = {
  ACTIVE: { kind: 'success', label: '사용 중' },
  EXPIRED: { kind: 'gray', label: '만료' },
  REVOKED: { kind: 'danger', label: '폐기' },
};

const endpoint = computed(() => `${window.location.origin}${mcpPath.value}`);
const config = computed(() =>
  JSON.stringify(
    {
      mcpServers: {
        termflow: {
          type: 'http',
          url: endpoint.value,
          headers: { Authorization: `Bearer ${issued.value?.token ?? '<토큰>'}` },
        },
      },
    },
    null,
    2,
  ),
);

async function load(): Promise<void> {
  try {
    const r = await auth.tokens();
    enabled.value = r.enabled;
    mcpPath.value = r.mcpPath;
    items.value = r.items;
  } catch {
    toast.error('접근 토큰 목록을 불러오지 못했습니다');
  } finally {
    loaded.value = true;
  }
}

async function issue(): Promise<void> {
  if (tokenNm.value.trim() === '' || busy.value) return;
  busy.value = true;
  try {
    const r = await auth.issueToken(tokenNm.value.trim(), Number(days.value));
    issued.value = { token: r.token, tokenNm: r.item.tokenNm };
    items.value = [r.item, ...items.value];
    tokenNm.value = '';
  } catch (e) {
    toast.error(
      e instanceof ApiError && e.problem?.detail
        ? String(e.problem.detail)
        : '토큰을 발급하지 못했습니다',
    );
  } finally {
    busy.value = false;
  }
}

async function copy(text: string, what: string): Promise<void> {
  if (await copyText(text)) toast.success(`${what}을(를) 복사했습니다`);
  else toast.error('복사하지 못했습니다. 직접 선택해 복사하세요');
}

async function revoke(): Promise<void> {
  const t = revoking.value;
  if (!t) return;
  revokeBusy.value = true;
  try {
    await auth.revokeToken(t.tokenId);
    toast.success(`'${t.tokenNm}' 토큰을 폐기했습니다`);
    revoking.value = null;
    await load();
  } catch {
    toast.error('토큰을 폐기하지 못했습니다');
  } finally {
    revokeBusy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="card mt-4" aria-labelledby="me-tokens">
    <div class="card-header">
      <h2 id="me-tokens" class="card-title"><TfIcon name="key" />외부 연동 접근 토큰</h2>
    </div>
    <p class="text-sm text-muted">
      에이전트 도구(MCP 클라이언트)가 내 권한으로 TermFlow를 쓰게 하는 토큰입니다. 토큰은
      비밀번호처럼 다루고, 쓰지 않으면 폐기하세요. 토큰으로 처리한 변경도 내 아이디로 기록됩니다.
    </p>

    <div v-if="loaded && !enabled" class="alert alert-info mt-2">
      <TfIcon name="info" />
      <div class="alert-body">
        이 서버는 외부 연동이 꺼져 있습니다(<span class="mono">TERMFLOW_MCP_ENABLED</span>).
        필요하면 시스템 관리자에게 요청하세요.
      </div>
    </div>

    <form v-else-if="loaded" class="row mt-2" novalidate @submit.prevent="issue">
      <TfInput
        id="token-nm"
        v-model="tokenNm"
        label="토큰 이름(용도)"
        placeholder="예: 내 PC 에이전트"
        :maxlength="100"
      />
      <TfSelect id="token-days" v-model="days" label="유효 기간" :options="DAY_OPTIONS" />
      <TfButton
        type="submit"
        variant="primary"
        icon="plus"
        :disabled="tokenNm.trim() === ''"
        :loading="busy"
      >
        발급
      </TfButton>
    </form>

    <div v-if="issued" class="alert alert-warning mt-2" data-testid="token-issued">
      <TfIcon name="alert-triangle" />
      <div class="alert-body stack-sm">
        <strong>'{{ issued.tokenNm }}' 토큰 — 지금만 볼 수 있습니다. 복사해 두세요.</strong>
        <div class="row">
          <code class="mono token-raw">{{ issued.token }}</code>
          <TfButton size="sm" icon="copy" @click="copy(issued.token, '토큰')">토큰 복사</TfButton>
        </div>
        <span class="text-sm"
          >연결 설정(MCP 클라이언트 설정 파일, 예: 프로젝트의
          <span class="mono">.mcp.json</span>):</span
        >
        <pre class="code token-config">{{ config }}</pre>
        <div class="row">
          <TfButton size="sm" icon="copy" @click="copy(config, '연결 설정')">설정 복사</TfButton>
          <span class="spacer" />
          <TfButton size="sm" variant="ghost" @click="issued = null">닫기</TfButton>
        </div>
      </div>
    </div>

    <div v-if="items.length > 0" class="table-wrap mt-2">
      <table class="table">
        <thead>
          <tr>
            <th>이름</th>
            <th>토큰 앞부분</th>
            <th>상태</th>
            <th>발급</th>
            <th>만료</th>
            <th>마지막 사용</th>
            <th aria-label="동작" />
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in items" :key="t.tokenId">
            <td>{{ t.tokenNm }}</td>
            <td class="mono">{{ t.tokenPrefix }}…</td>
            <td>
              <TfBadge :kind="STATUS[t.status].kind">{{ STATUS[t.status].label }}</TfBadge>
            </td>
            <td class="mono text-sm">{{ t.createdAt.slice(0, 16) }}</td>
            <td class="mono text-sm">{{ t.expiresAt.slice(0, 10) }}</td>
            <td class="mono text-sm">
              {{ t.lastUsedAt ? `${t.lastUsedAt.slice(0, 16)} · ${t.lastUsedIp ?? ''}` : '—' }}
            </td>
            <td>
              <TfButton
                v-if="t.status === 'ACTIVE'"
                size="sm"
                variant="ghost"
                icon="trash"
                @click="revoking = t"
              >
                폐기
              </TfButton>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else-if="loaded && enabled" class="text-sm text-muted mt-2">발급한 토큰이 없습니다.</p>
  </section>

  <ConfirmDeleteModal
    :open="revoking !== null"
    :title="`'${revoking?.tokenNm}' 토큰을 폐기할까요?`"
    confirm-label="폐기"
    :busy="revokeBusy"
    @cancel="revoking = null"
    @confirm="revoke"
  >
    폐기하면 이 토큰을 쓰는 연동이 바로 끊깁니다. 되돌릴 수 없습니다.
  </ConfirmDeleteModal>
</template>

<style scoped>
.token-raw {
  word-break: break-all;
  user-select: all;
}
.token-config {
  max-height: 16rem;
  overflow: auto;
  margin: 0;
}
</style>
