<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { PROJECT_KEY_RE, type AdminProjectItem, type TemplateItem } from '@termflow/shared';
import { ApiError } from '../api/client.js';
import { projectsApi } from '../api/projects.js';
import ConfirmDeleteModal from '../components/ui/ConfirmDeleteModal.vue';
import EmptyState from '../components/ui/EmptyState.vue';
import TfBadge from '../components/ui/TfBadge.vue';
import TfButton from '../components/ui/TfButton.vue';
import TfCheckbox from '../components/ui/TfCheckbox.vue';
import TfIcon from '../components/ui/TfIcon.vue';
import TfPopover from '../components/ui/TfPopover.vue';
import { useSessionStore } from '../stores/session.js';
import { useToastStore } from '../stores/toast.js';

/**
 * 시스템 › 템플릿(`/admin/templates`, 목업 16, §4.6): 목록(건수·파생 프로젝트 수), [프로젝트에서 템플릿 게시] 인라인 폼
 * (원본·이름·키·승인된 용어만·설명), 편집(→ 템플릿의 업무구분·표준 화면), 보관·복원, 삭제(사용 중이면 비활성 — 보관만).
 */
const api = projectsApi();
const toast = useToastStore();
const session = useSessionStore();
const items = ref<TemplateItem[]>([]);
const projects = ref<AdminProjectItem[]>([]);
const loading = ref(true);

async function load(): Promise<void> {
  loading.value = true;
  try {
    [items.value, projects.value] = await Promise.all([api.templates(), api.adminProjects()]);
  } catch {
    toast.error('템플릿 목록을 불러오지 못했습니다');
  } finally {
    loading.value = false;
  }
}
onMounted(load);
const n = (v: number) => v.toLocaleString('ko-KR');

// ── 게시 폼 ─────────────────────────────────────────────────
const publishing = ref(false);
const form = reactive({ source: '', nm: '', key: '', approvedOnly: true, description: '' });
const keyState = ref<{ available: boolean | null; reason?: string }>({ available: null });
const sourceOptions = computed(() => [
  ...projects.value.map((p) => ({ key: p.key, label: `${p.key} · ${p.nm}` })),
  ...items.value.map((t) => ({ key: t.key, label: `${t.key} · ${t.nm}(템플릿)` })),
]);
function openPublish(): void {
  publishing.value = !publishing.value;
  Object.assign(form, {
    source: sourceOptions.value[0]?.key ?? '',
    nm: '',
    key: '',
    approvedOnly: true,
    description: '',
  });
  keyState.value = { available: null };
}
let timer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => form.key,
  (v) => {
    const up = v.toUpperCase().replace(/\s/g, '');
    if (up !== v) {
      form.key = up;
      return;
    }
    clearTimeout(timer);
    if (!up) return void (keyState.value = { available: null });
    if (!PROJECT_KEY_RE.test(up))
      return void (keyState.value = {
        available: false,
        reason: '영문 대문자로 시작하는 영문 대문자·숫자 2~10자',
      });
    timer = setTimeout(async () => {
      keyState.value = await api.checkKey(up).catch(() => ({ available: null }));
    }, 300);
  },
);
const canPublish = computed(
  () => form.source !== '' && form.nm.trim() !== '' && keyState.value.available === true,
);
const busy = ref(false);
async function publish(): Promise<void> {
  if (!canPublish.value) return;
  busy.value = true;
  try {
    const r = await api.publishTemplate({
      sourceProjectKey: form.source,
      projectKey: form.key,
      projectNm: form.nm.trim(),
      description: form.description.trim() || null,
      approvedOnly: form.approvedOnly,
    });
    toast.success(
      `템플릿 '${form.nm.trim()}'을(를) 게시했습니다 · 복사 ${(r.elapsedMs / 1000).toFixed(1)}초`,
    );
    publishing.value = false;
    await Promise.all([load(), session.refresh()]);
  } catch (e) {
    toast.error(
      e instanceof ApiError && e.problem?.detail ? e.problem.detail : '게시하지 못했습니다',
    );
  } finally {
    busy.value = false;
  }
}

// ── 보관·삭제 ────────────────────────────────────────────────
async function setStatus(t: TemplateItem, s: 'ACTIVE' | 'ARCHIVED'): Promise<void> {
  try {
    await api.setTemplateStatus(t.key, s);
    toast.success(
      s === 'ARCHIVED' ? `${t.key} 보관 — 마법사 원본 선택지에서 숨깁니다` : `${t.key} 복원`,
    );
    await load();
  } catch (e) {
    toast.error(
      e instanceof ApiError && e.problem?.detail ? e.problem.detail : '처리하지 못했습니다',
    );
  }
}
const deleting = ref<TemplateItem | null>(null);
const confirmKey = ref('');
async function remove(): Promise<void> {
  const t = deleting.value;
  if (!t) return;
  busy.value = true;
  try {
    await api.deleteTemplate(t.key, confirmKey.value);
    toast.success(`${t.key}을(를) 삭제했습니다`);
    deleting.value = null;
    await Promise.all([load(), session.refresh()]);
  } catch (e) {
    toast.error(
      e instanceof ApiError && e.problem?.detail ? e.problem.detail : '삭제하지 못했습니다',
    );
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="page-header">
    <div>
      <div class="breadcrumb"><span>시스템</span><span>›</span><span>템플릿</span></div>
      <h1 class="page-title">
        표준 템플릿 <span class="count-pill">{{ items.length }}</span>
      </h1>
      <p class="page-desc">
        새 프로젝트에 업무구분·표준 사전을 공급하는 읽기 전용 원본입니다. 가져오기는 생성 시점의
        스냅샷 복사이며, 템플릿을 바꿔도 이미 만든 프로젝트에는 반영되지 않습니다. 시스템 관리자
        전용.
      </p>
    </div>
    <div class="page-actions">
      <TfButton variant="primary" icon="upload" :aria-expanded="publishing" @click="openPublish"
        >프로젝트에서 템플릿 게시</TfButton
      >
    </div>
  </div>

  <section v-if="publishing" class="card mb-4" aria-label="템플릿 게시">
    <div class="card-header">
      <div class="card-title"><TfIcon name="upload" />프로젝트에서 템플릿 게시</div>
      <span class="text-sm text-muted">스냅샷 복사로 새 템플릿 생성</span>
    </div>
    <div class="grid-4">
      <div class="field">
        <label class="field-label" for="tp-src">원본 <span class="req">*</span></label>
        <select id="tp-src" v-model="form.source" class="select">
          <option v-for="o in sourceOptions" :key="o.key" :value="o.key">{{ o.label }}</option>
        </select>
      </div>
      <div class="field">
        <label class="field-label" for="tp-name">템플릿 이름 <span class="req">*</span></label>
        <input
          id="tp-name"
          v-model="form.nm"
          class="input"
          maxlength="100"
          placeholder="예) 연구기관 표준 v1"
        />
      </div>
      <div class="field">
        <label class="field-label" for="tp-key">키 <span class="req">*</span></label>
        <input
          id="tp-key"
          v-model="form.key"
          :class="[
            'input',
            'mono',
            { 'is-valid': keyState.available === true, 'is-invalid': keyState.available === false },
          ]"
          maxlength="10"
          autocomplete="off"
        />
        <span v-if="keyState.available === true" class="field-help text-success"
          ><TfIcon name="check" size="sm" />사용 가능</span
        >
        <span v-else-if="keyState.available === false" class="field-error"
          ><TfIcon name="alert-circle" size="sm" />{{ keyState.reason }}</span
        >
      </div>
      <div class="field">
        <span class="field-label">용어</span>
        <TfCheckbox v-model="form.approvedOnly" class="mt-2"
          >승인된 용어만 <span class="text-muted">(검토대기·반려 제외)</span></TfCheckbox
        >
      </div>
    </div>
    <div class="field mt-3">
      <label class="field-label" for="tp-desc">설명</label>
      <input id="tp-desc" v-model="form.description" class="input" maxlength="4000" />
    </div>
    <p class="text-sm text-muted mt-3">
      업무구분·표준 사전 전체를 복사합니다 · 테이블·멤버·이력은 포함하지 않습니다 · 원본은 바뀌지
      않습니다.
    </p>
    <div class="row mt-4">
      <TfButton variant="primary" :disabled="!canPublish" :loading="busy" @click="publish"
        >게시</TfButton
      >
      <TfButton variant="ghost" @click="publishing = false">취소</TfButton>
    </div>
  </section>

  <div class="table-wrap">
    <table class="table">
      <caption class="sr-only">
        표준 템플릿
      </caption>
      <thead>
        <tr>
          <th>템플릿</th>
          <th class="num">업무구분</th>
          <th class="num">용어</th>
          <th class="num">도메인분류</th>
          <th class="num">도메인</th>
          <th class="num">코드구분</th>
          <th class="num">코드</th>
          <th class="num">기본컬럼</th>
          <th>게시</th>
          <th class="num">사용 프로젝트</th>
          <th class="col-menu" />
        </tr>
      </thead>
      <tbody>
        <tr v-for="t in items" :key="t.key" :class="{ 'is-disabled': t.status === 'ARCHIVED' }">
          <td>
            <div class="row">
              <span class="project-key">{{ t.key }}</span>
              <div>
                <div class="fw-600">
                  {{ t.nm }} <TfBadge v-if="t.status === 'ARCHIVED'" kind="draft">보관됨</TfBadge>
                </div>
                <div class="text-sm text-muted">
                  {{ t.description ?? (t.publishedFrom ? `${t.publishedFrom.key}에서 게시` : '') }}
                </div>
              </div>
            </div>
          </td>
          <td class="num">{{ n(t.counts.bizArea) }}</td>
          <td class="num">{{ n(t.counts.term) }}</td>
          <td class="num">{{ n(t.counts.domainCls) }}</td>
          <td class="num">{{ n(t.counts.domain) }}</td>
          <td class="num">{{ n(t.counts.codeCls) }}</td>
          <td class="num">{{ n(t.counts.code) }}</td>
          <td class="num">{{ n(t.counts.defaultCol) }}</td>
          <td class="nowrap">{{ t.createdAt.slice(0, 10) }} · {{ t.createdBy }}</td>
          <td class="num">{{ t.derivedCnt }}</td>
          <td class="col-menu">
            <TfPopover align="right">
              <template #trigger="{ toggle, open, menuId }">
                <button
                  class="btn btn-ghost btn-sm btn-icon"
                  type="button"
                  :aria-label="`${t.key} 행 메뉴`"
                  aria-haspopup="menu"
                  :aria-expanded="open"
                  :aria-controls="menuId"
                  @click="toggle"
                >
                  <TfIcon name="more" />
                </button>
              </template>
              <template #default="{ close }">
                <RouterLink
                  class="dropdown-item"
                  role="menuitem"
                  :to="`/projects/${t.key}/biz-areas`"
                  @click="close()"
                  ><TfIcon name="edit" />편집(업무구분)</RouterLink
                >
                <RouterLink
                  v-if="t.status === 'ACTIVE'"
                  class="dropdown-item"
                  role="menuitem"
                  :to="{ path: '/projects/new', query: { template: t.key } }"
                  @click="close()"
                  ><TfIcon name="plus" />이 템플릿으로 새 프로젝트</RouterLink
                >
                <button
                  v-if="t.status === 'ACTIVE'"
                  class="dropdown-item"
                  type="button"
                  role="menuitem"
                  @click="(close(), setStatus(t, 'ARCHIVED'))"
                >
                  <TfIcon name="lock" />보관
                </button>
                <button
                  v-else
                  class="dropdown-item"
                  type="button"
                  role="menuitem"
                  @click="(close(), setStatus(t, 'ACTIVE'))"
                >
                  <TfIcon name="unlock" />복원
                </button>
                <div class="dropdown-sep" />
                <button
                  class="dropdown-item is-danger"
                  type="button"
                  role="menuitem"
                  :disabled="t.derivedCnt > 0"
                  :title="t.derivedCnt > 0 ? '사용 중인 프로젝트가 있어 보관만 가능' : ''"
                  @click="(close(), (deleting = t), (confirmKey = ''))"
                >
                  <TfIcon name="trash" />삭제{{ t.derivedCnt > 0 ? ' (사용 중)' : '' }}
                </button>
              </template>
            </TfPopover>
          </td>
        </tr>
        <tr v-if="!loading && items.length === 0">
          <td colspan="11">
            <EmptyState
              in-table
              icon="layers"
              title="템플릿이 없습니다"
              desc="기본 표준 템플릿(STDV1)은 서버를 처음 기동할 때 만들어집니다. 지웠다면 프로젝트를 템플릿으로 게시하십시오."
            />
          </td>
        </tr>
      </tbody>
    </table>
    <div class="table-footer">
      템플릿은 프로젝트 목록에 나오지 않습니다 · 개정은 새 버전으로 다시 게시하는 것을 권장합니다
    </div>
  </div>

  <ConfirmDeleteModal
    :open="deleting !== null"
    :title="`템플릿 '${deleting?.nm}'을(를) 삭제할까요?`"
    :busy="busy"
    :confirm-disabled="confirmKey !== deleting?.key"
    @cancel="deleting = null"
    @confirm="remove"
  >
    이 템플릿의 업무구분·표준 사전이 삭제됩니다. 파생 프로젝트가 없는 템플릿만 삭제할 수 있습니다.
    확인을 위해 키
    <strong class="mono">{{ deleting?.key }}</strong
    >를 입력하세요.
    <input
      v-model="confirmKey"
      class="input mono mt-3 w-120"
      :placeholder="deleting?.key"
      aria-label="확인용 키"
    />
  </ConfirmDeleteModal>
</template>
