<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import {
  PROJECT_KEY_RE,
  type AdminUserItem,
  type CopyPreviewItem,
  type CopyPreviewResponse,
  type CopySourceItem,
  type CopySourceKind,
  type CopySourcesResponse,
  type MemberRole,
  type ProjectCreateResponse,
  type StdEntityType,
} from '@termflow/shared';
import { ApiError } from '../api/client.js';
import { projectsApi, type ImportSource, type ImportsInput } from '../api/projects.js';
import { usersApi } from '../api/users.js';
import { ROLE_LABEL } from '../components/layout/labels.js';
import TfBadge from '../components/ui/TfBadge.vue';
import TfButton from '../components/ui/TfButton.vue';
import TfCheckbox from '../components/ui/TfCheckbox.vue';
import TfIcon from '../components/ui/TfIcon.vue';
import { hasScreen } from '../router.js';
import { useSessionStore } from '../stores/session.js';
import { useToastStore } from '../stores/toast.js';

/**
 * 프로젝트 생성 마법사(`/projects/new`, 목업 02b, §4.3·§10.1, 시스템 관리자). 한 페이지 3단계:
 *  1 기본 정보(키 즉시 검사) · 2 표준 가져오기(항목별 [템플릿][다른 프로젝트][비움], 업무구분 체크, 승인 용어만,
 *  우측 건수 미리보기, 원본이 섞이면 C3 경고) · 3 멤버(선택). 생성은 한 트랜잭션 → 결과 요약 → 홈.
 * 코드는 업무구분 원본을 따른다(목업 02b "업무구분 원본을 따름", C4).
 */
const api = projectsApi();
const users = usersApi();
const session = useSessionStore();
const toast = useToastStore();
const route = useRoute();
const router = useRouter();

type ItemKey = 'bizAreas' | 'terms' | 'domainClasses' | 'domains' | 'defaultColSets';
const ITEMS: { key: ItemKey; label: string }[] = [
  { key: 'bizAreas', label: '업무구분' },
  { key: 'terms', label: '용어' },
  { key: 'domainClasses', label: '도메인분류' },
  { key: 'domains', label: '도메인' },
  { key: 'defaultColSets', label: '기본컬럼 세트' },
];
/** 원본 표의 건수 열에 보이는 항목(기본컬럼 세트는 구성 건수). */
const ITEM_ENTITY: Record<ItemKey, StdEntityType> = {
  bizAreas: 'BIZ_AREA',
  terms: 'TERM',
  domainClasses: 'DOMAIN_CLS',
  domains: 'DOMAIN',
  defaultColSets: 'DEFAULT_COL',
};
const KIND_LABEL: Record<CopySourceKind, string> = {
  TEMPLATE: '템플릿',
  PROJECT: '다른 프로젝트',
  EMPTY: '비움',
};

// ── 1. 기본 정보 ──────────────────────────────────────────────
const basic = reactive({ name: '', key: '', description: '', dialect: 'POSTGRESQL' as const });
const keyState = ref<{ checking: boolean; available: boolean | null; reason?: string }>({
  checking: false,
  available: null,
});
const keyFormatOk = computed(() => PROJECT_KEY_RE.test(basic.key));
let keyTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => basic.key,
  (v) => {
    const up = v.toUpperCase().replace(/\s/g, '');
    if (up !== v) {
      basic.key = up;
      return;
    }
    clearTimeout(keyTimer);
    keyState.value = { checking: false, available: null };
    if (!up) return;
    if (!keyFormatOk.value) {
      keyState.value = {
        checking: false,
        available: false,
        reason: '영문 대문자로 시작하는 영문 대문자·숫자 2~10자',
      };
      return;
    }
    keyState.value = { checking: true, available: null };
    keyTimer = setTimeout(async () => {
      try {
        const r = await api.checkKey(up);
        if (basic.key === up) keyState.value = { checking: false, ...r };
      } catch {
        keyState.value = { checking: false, available: null };
      }
    }, 300);
  },
);
const basicDone = computed(
  () => basic.name.trim() !== '' && keyFormatOk.value && keyState.value.available === true,
);

// ── 2. 표준 가져오기 ──────────────────────────────────────────
const sources = ref<CopySourcesResponse>({ templates: [], projects: [] });
const picks = reactive<Record<ItemKey, { kind: CopySourceKind; key: string }>>({
  bizAreas: { kind: 'EMPTY', key: '' },
  terms: { kind: 'EMPTY', key: '' },
  domainClasses: { kind: 'EMPTY', key: '' },
  domains: { kind: 'EMPTY', key: '' },
  defaultColSets: { kind: 'EMPTY', key: '' },
});
const bizCds = ref<string[]>([]);
const approvedOnly = ref(true);

const listOf = (kind: CopySourceKind): CopySourceItem[] =>
  kind === 'TEMPLATE' ? sources.value.templates : kind === 'PROJECT' ? sources.value.projects : [];
const sourceOf = (k: ItemKey): CopySourceItem | undefined =>
  listOf(picks[k].kind).find((s) => s.key === picks[k].key);
const defaultTemplate = computed(
  () =>
    sources.value.templates.find((t) => t.key === route.query['template']) ??
    sources.value.templates.find((t) => t.key === 'STDV1') ??
    sources.value.templates[0],
);

function setKind(k: ItemKey, kind: CopySourceKind): void {
  const first = listOf(kind)[0];
  picks[k] = kind === 'EMPTY' || !first ? { kind: 'EMPTY', key: '' } : { kind, key: first.key };
}
function allTo(kind: 'TEMPLATE' | 'EMPTY'): void {
  for (const i of ITEMS) {
    picks[i.key] =
      kind === 'TEMPLATE' && defaultTemplate.value
        ? { kind: 'TEMPLATE', key: defaultTemplate.value.key }
        : { kind: 'EMPTY', key: '' };
  }
}
// 업무구분 원본이 바뀌면 체크를 그 원본의 업무구분 전체로
watch(
  () => `${picks.bizAreas.kind}:${picks.bizAreas.key}`,
  () => {
    bizCds.value = sourceOf('bizAreas')?.bizAreas.map((b) => b.bizCd) ?? [];
  },
);
function toggleBiz(cd: string, on: boolean): void {
  bizCds.value = on ? [...new Set([...bizCds.value, cd])] : bizCds.value.filter((c) => c !== cd);
}

const src = (k: ItemKey): ImportSource =>
  picks[k].kind === 'EMPTY'
    ? { source: 'EMPTY' }
    : { source: picks[k].kind, sourceKey: picks[k].key };
const imports = computed<ImportsInput>(() => {
  const biz = src('bizAreas');
  const allBiz = sourceOf('bizAreas')?.bizAreas.map((b) => b.bizCd) ?? [];
  const selected = allBiz.filter((c) => bizCds.value.includes(c));
  return {
    bizAreas: { ...biz, ...(selected.length === allBiz.length ? {} : { bizCds: selected }) },
    terms: { ...src('terms'), approvedOnly: approvedOnly.value },
    domainClasses: src('domainClasses'),
    domains: src('domains'),
    codes: biz,
    defaultColSets: src('defaultColSets'),
  };
});

const preview = ref<CopyPreviewResponse | null>(null);
const previewBusy = ref(false);
let previewTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  imports,
  () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      previewBusy.value = true;
      try {
        preview.value = await api.preview(imports.value);
      } catch {
        preview.value = null;
      } finally {
        previewBusy.value = false;
      }
    }, 250);
  },
  { deep: true },
);
const pv = (item: StdEntityType): CopyPreviewItem | undefined =>
  preview.value?.items.find((i) => i.item === item);
const count = (item: StdEntityType) => (pv(item)?.toCopy ?? 0).toLocaleString('ko-KR');
const same = (a: ItemKey, b: ItemKey) =>
  picks[a].kind === picks[b].kind && picks[a].key === picks[b].key;
const c3Mixed = computed(
  () =>
    picks.domains.kind !== 'EMPTY' &&
    !(same('terms', 'domains') && same('domainClasses', 'domains')),
);
const pickLabel = (k: ItemKey) =>
  picks[k].kind === 'EMPTY' ? '비움' : (sourceOf(k)?.nm ?? picks[k].key);
function alignToDomains(): void {
  picks.terms = { ...picks.domains };
  picks.domainClasses = { ...picks.domains };
}
const bizWarnings = computed(
  () => preview.value?.warnings.filter((w) => w.code !== 'W_COPY_SOURCE_MIXED') ?? [],
);

// ── 3. 멤버 ──────────────────────────────────────────────────
const memberQ = ref('');
const memberHits = ref<AdminUserItem[]>([]);
const memberPick = ref<AdminUserItem | null>(null);
const memberRole = ref<MemberRole>('EDITOR');
const members = ref<{ userId: number; loginId: string; userNm: string; role: MemberRole }[]>([]);
let memberTimer: ReturnType<typeof setTimeout> | undefined;
watch(memberQ, (v) => {
  clearTimeout(memberTimer);
  if (memberPick.value && v === `${memberPick.value.userNm}`) return;
  memberPick.value = null;
  if (v.trim() === '') {
    memberHits.value = [];
    return;
  }
  memberTimer = setTimeout(async () => {
    try {
      const page = await users.list({ q: v.trim(), status: 'ALL', size: 10 });
      memberHits.value = page.items.filter((u) => u.isActive);
    } catch {
      memberHits.value = [];
    }
  }, 250);
});
function choose(u: AdminUserItem): void {
  memberPick.value = u;
  memberQ.value = u.userNm;
  memberHits.value = [];
}
const isListed = (id: number) =>
  id === session.user?.id || members.value.some((m) => m.userId === id);
function addMember(): void {
  const u = memberPick.value;
  if (!u || isListed(u.id)) return;
  members.value.push({
    userId: u.id,
    loginId: u.loginId,
    userNm: u.userNm,
    role: memberRole.value,
  });
  memberPick.value = null;
  memberQ.value = '';
}

// ── 생성 ─────────────────────────────────────────────────────
const creating = ref(false);
const result = ref<ProjectCreateResponse | null>(null);
const canCreate = computed(() => basicDone.value && !creating.value);
async function create(): Promise<void> {
  if (!canCreate.value) return;
  creating.value = true;
  try {
    result.value = await api.create({
      projectKey: basic.key,
      projectNm: basic.name.trim(),
      description: basic.description.trim() || null,
      defaultDialect: basic.dialect,
      imports: imports.value,
      members: members.value.map((m) => ({ userId: m.userId, role: m.role })),
    });
    toast.success(`프로젝트 ${result.value.projectKey}을(를) 만들었습니다`);
    await session.refresh();
  } catch (e) {
    if (e instanceof ApiError && e.code === 'E_PROJECT_KEY_DUP') {
      keyState.value = { checking: false, available: false, reason: '이미 사용 중인 키입니다' };
      toast.error('이미 사용 중인 프로젝트 키입니다');
    } else if (e instanceof ApiError && e.problem) {
      const errs = (e.problem['errors'] as { message: string }[] | undefined) ?? [];
      toast.error(
        errs.length
          ? errs.map((x) => x.message).join(' · ')
          : (e.problem.detail ?? '생성하지 못했습니다'),
      );
    } else {
      toast.error('프로젝트를 만들지 못했습니다');
    }
  } finally {
    creating.value = false;
  }
}
const ITEM_LABEL: Record<StdEntityType, string> = {
  BIZ_AREA: '업무구분',
  TERM: '용어',
  DOMAIN_CLS: '도메인분류',
  DOMAIN: '도메인',
  CODE_CLS: '코드구분',
  CODE: '코드',
  DEFAULT_COL_SET: '기본컬럼 세트',
  DEFAULT_COL: '기본컬럼',
};
const reviewLink = computed(() =>
  result.value && hasScreen(result.value.c3Revalidation.reviewListUrl)
    ? result.value.c3Revalidation.reviewListUrl
    : null,
);
const totalCopied = computed(() => result.value?.items.reduce((s, i) => s + i.copied, 0) ?? 0);

onMounted(async () => {
  try {
    sources.value = await api.copySources();
    allTo('TEMPLATE');
  } catch {
    toast.error('가져오기 원본 목록을 불러오지 못했습니다');
  }
});
const footerSummary = computed(() =>
  [
    basic.key || '(키)',
    `업무구분 ${count('BIZ_AREA')}`,
    `용어 ${count('TERM')}`,
    `도메인 ${count('DOMAIN')}${c3Mixed.value ? '(재검증)' : ''}`,
    `멤버 ${members.value.length + 1}`,
  ].join(' · '),
);
function goHome(): void {
  if (result.value) void router.push(`/projects/${result.value.projectKey}`);
}
</script>

<template>
  <div class="page-header">
    <div>
      <div class="breadcrumb">
        <RouterLink to="/projects">프로젝트</RouterLink><span>›</span><span>새 프로젝트</span>
      </div>
      <h1 class="page-title">새 프로젝트</h1>
      <p class="page-desc">
        한 페이지 3단계 · 생성과 표준 복사는 한 트랜잭션으로 처리되며, 실패하면 아무것도 만들어지지
        않습니다. 생성자는 자동으로 프로젝트 관리자가 됩니다.
      </p>
    </div>
    <nav v-if="!result" class="steps" aria-label="단계">
      <a :class="['step', basicDone ? 'is-done' : 'is-current']" href="#step-1"
        ><span class="step-num"
          ><TfIcon v-if="basicDone" name="check" size="sm" /><template v-else>1</template></span
        >기본 정보</a
      >
      <span class="step-sep" />
      <a :class="['step', { 'is-current': basicDone }]" href="#step-2"
        ><span class="step-num">2</span>표준 가져오기</a
      >
      <span class="step-sep" />
      <a class="step" href="#step-3"><span class="step-num">3</span>멤버</a>
    </nav>
  </div>

  <!-- 결과 요약 -->
  <section v-if="result" class="card mb-6" aria-label="생성 결과">
    <div class="card-header">
      <div class="card-title">
        <TfIcon name="check-circle" class="text-success" />프로젝트
        <span class="project-key">{{ result.projectKey }}</span
        >를 만들었습니다
      </div>
      <span class="text-sm text-muted"
        >복사 {{ totalCopied.toLocaleString('ko-KR') }}건 ·
        {{ (result.elapsedMs / 1000).toFixed(1) }}초</span
      >
    </div>
    <div
      v-if="result.c3Revalidation.performed || result.c3Revalidation.reviewDomainCnt > 0"
      :class="[
        'alert',
        result.c3Revalidation.flaggedCnt > 0 ? 'alert-warning' : 'alert-info',
        'mb-4',
      ]"
      role="status"
    >
      <TfIcon name="alert-triangle" />
      <div class="alert-body">
        <div class="alert-title" data-testid="review-banner">
          검토필요 도메인 {{ result.c3Revalidation.reviewDomainCnt.toLocaleString('ko-KR') }}건
          <template v-if="result.c3Revalidation.performed">
            (복사 후 재검증으로 새로 표시
            {{ result.c3Revalidation.flaggedCnt.toLocaleString('ko-KR') }}건)</template
          >
        </div>
        <template v-if="result.c3Revalidation.performed"
          >{{ result.c3Revalidation.reason }}.
        </template>
        <span
          v-for="s in result.c3Revalidation.samples.slice(0, 3)"
          :key="s.domainId"
          class="mono text-sm"
          >{{ s.logicalNm }}: {{ s.reason }}&nbsp;
        </span>
      </div>
      <div v-if="reviewLink" class="alert-actions">
        <RouterLink class="btn btn-secondary btn-sm" :to="reviewLink">확인</RouterLink>
      </div>
    </div>
    <table class="table table-compact">
      <thead>
        <tr>
          <th>항목</th>
          <th>원본</th>
          <th class="num">원본 건수</th>
          <th class="num">복사</th>
          <th class="num">제외</th>
          <th
            class="num"
            title="복사 후 재검증에서 새로 검토필요로 표시한 행(원본에서 이미 검토필요였던 행은 제외)"
          >
            재검증 표시
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="i in result.items" :key="i.item">
          <td>{{ ITEM_LABEL[i.item] }}</td>
          <td class="text-2">
            {{
              i.sourceKind === 'EMPTY' ? '비움' : `${KIND_LABEL[i.sourceKind!]} · ${i.sourceKey}`
            }}
          </td>
          <td class="num">{{ i.sourceCnt.toLocaleString('ko-KR') }}</td>
          <td class="num fw-600">{{ i.copied.toLocaleString('ko-KR') }}</td>
          <td class="num text-muted">{{ i.skipped.toLocaleString('ko-KR') }}</td>
          <td class="num">{{ i.flagged ? i.flagged.toLocaleString('ko-KR') : '—' }}</td>
        </tr>
      </tbody>
    </table>
    <div class="row mt-4">
      <TfButton variant="primary" icon="home" @click="goHome">프로젝트 홈으로</TfButton>
      <RouterLink
        class="btn btn-secondary"
        :to="`/projects/${result.projectKey}/settings?tab=members`"
        >멤버 관리</RouterLink
      >
    </div>
  </section>

  <template v-else>
    <!-- 1. 기본 정보 -->
    <section id="step-1" class="card wizard-section">
      <div class="card-header">
        <div class="card-title"><span class="count-pill">1</span>기본 정보</div>
        <TfBadge v-if="basicDone" kind="approved" icon="check">입력 완료</TfBadge>
      </div>
      <div class="grid-4">
        <div class="field">
          <label class="field-label" for="n-name">이름 <span class="req">*</span></label>
          <input
            id="n-name"
            v-model="basic.name"
            class="input"
            maxlength="100"
            placeholder="예) OO기관 인사시스템 고도화"
          />
        </div>
        <div class="field">
          <label class="field-label" for="n-key">키 <span class="req">*</span></label>
          <input
            id="n-key"
            v-model="basic.key"
            :class="[
              'input',
              'mono',
              {
                'is-valid': keyState.available === true,
                'is-invalid': keyState.available === false,
              },
            ]"
            maxlength="10"
            placeholder="예) HRM26"
            autocomplete="off"
            :aria-invalid="keyState.available === false ? 'true' : undefined"
            aria-describedby="n-key-msg"
          />
          <span v-if="keyState.available === true" id="n-key-msg" class="field-help text-success"
            ><TfIcon name="check" size="sm" />사용 가능 · URL
            <span class="mono">/projects/{{ basic.key }}</span></span
          >
          <span v-else-if="keyState.available === false" id="n-key-msg" class="field-error"
            ><TfIcon name="alert-circle" size="sm" />{{ keyState.reason }}</span
          >
          <span v-else id="n-key-msg" class="field-help">{{
            keyState.checking ? '확인 중…' : '영문 대문자·숫자 2~10자'
          }}</span>
        </div>
        <div class="field">
          <label class="field-label" for="n-dialect">기본 DDL 방언</label>
          <select id="n-dialect" v-model="basic.dialect" class="select">
            <option value="POSTGRESQL">PostgreSQL</option>
          </select>
          <span class="field-help">현재는 PostgreSQL만 지원</span>
        </div>
        <div class="field">
          <label class="field-label" for="n-desc">설명</label>
          <input id="n-desc" v-model="basic.description" class="input" maxlength="4000" />
        </div>
      </div>
      <p class="text-sm text-muted mt-3">
        <TfIcon name="info" size="sm" /> 키는 영문 대문자·숫자 2~10자로 URL·식별용이며 생성 후 바꿀
        수 없습니다. 테이블 접두어(예 <span class="mono">PS_</span>)는 업무구분이 정합니다.
      </p>
    </section>

    <!-- 2. 표준 가져오기 -->
    <section id="step-2" class="wizard-section">
      <div class="split split-wide">
        <div class="card card-flush wizard-section is-current">
          <div class="card-header">
            <div class="card-title"><span class="count-pill info">2</span>표준 가져오기</div>
            <div class="row">
              <span class="text-sm text-muted">모두</span>
              <TfButton size="sm" :disabled="!defaultTemplate" @click="allTo('TEMPLATE')"
                >템플릿으로</TfButton
              >
              <TfButton size="sm" variant="ghost" @click="allTo('EMPTY')">비움</TfButton>
            </div>
          </div>
          <table class="table">
            <thead>
              <tr>
                <th class="w-120">항목</th>
                <th>원본</th>
                <th>옵션</th>
                <th class="num">건수</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="it in ITEMS" :key="it.key">
                <tr
                  :class="['import-row', { 'is-selected': it.key === 'domains' && c3Mixed }]"
                  :data-item="it.key"
                >
                  <td class="fw-600">
                    {{ it.label }}
                    <TfBadge v-if="it.key === 'domains' && c3Mixed" kind="warning"
                      >원본 다름</TfBadge
                    >
                  </td>
                  <td>
                    <div class="src-pick">
                      <div class="seg" role="group" :aria-label="`${it.label} 원본 종류`">
                        <button
                          v-for="k in ['TEMPLATE', 'PROJECT', 'EMPTY'] as const"
                          :key="k"
                          type="button"
                          :class="{ 'is-active': picks[it.key].kind === k }"
                          :aria-pressed="picks[it.key].kind === k"
                          :disabled="k !== 'EMPTY' && listOf(k).length === 0"
                          @click="setKind(it.key, k)"
                        >
                          {{ KIND_LABEL[k] }}
                        </button>
                      </div>
                      <select
                        v-if="picks[it.key].kind !== 'EMPTY'"
                        v-model="picks[it.key].key"
                        class="select select-sm w-200"
                        :aria-label="`${it.label} 원본`"
                      >
                        <option v-for="s in listOf(picks[it.key].kind)" :key="s.key" :value="s.key">
                          {{ s.kind === 'PROJECT' ? `${s.key} · ${s.nm}` : s.nm }}
                        </option>
                      </select>
                    </div>
                  </td>
                  <td>
                    <template v-if="it.key === 'bizAreas'">
                      <div v-if="sourceOf('bizAreas')" class="row wrap">
                        <TfCheckbox
                          v-for="b in sourceOf('bizAreas')!.bizAreas"
                          :key="b.bizCd"
                          :model-value="bizCds.includes(b.bizCd)"
                          @update:model-value="(v: boolean) => toggleBiz(b.bizCd, v)"
                          ><span class="mono">{{ b.bizCd }}</span> {{ b.bizNm }}</TfCheckbox
                        >
                      </div>
                      <span class="field-help">선택한 업무구분의 코드구분·코드만 복사됩니다</span>
                    </template>
                    <TfCheckbox v-else-if="it.key === 'terms'" v-model="approvedOnly"
                      >승인된 용어만
                      <span class="text-muted">(검토대기·반려 제외)</span></TfCheckbox
                    >
                    <span v-else-if="it.key === 'domains' && c3Mixed" class="text-sm text-2"
                      >복사 후 도메인 계산 규칙으로 재검증, 불일치 행은 검토필요로 표시</span
                    >
                    <span v-else-if="it.key === 'defaultColSets'" class="text-sm text-muted"
                      >프로젝트 기본 세트로 지정</span
                    >
                  </td>
                  <td class="num">
                    {{ count(ITEM_ENTITY[it.key]) }}
                  </td>
                </tr>
                <tr v-if="it.key === 'bizAreas'" class="import-row" data-item="codes">
                  <td class="fw-600">코드</td>
                  <td>
                    <span class="text-2">업무구분 원본을 따름</span>
                    <span class="text-sm text-muted"> ({{ pickLabel('bizAreas') }})</span>
                  </td>
                  <td class="text-sm text-muted">선택한 업무구분에 속한 코드구분·코드</td>
                  <td class="num nowrap">{{ count('CODE_CLS') }} / {{ count('CODE') }}</td>
                </tr>
              </template>
            </tbody>
          </table>
          <div v-if="c3Mixed" class="alert alert-warning card-inset" data-testid="c3-warning">
            <TfIcon name="alert-triangle" />
            <div class="alert-body">
              <div class="alert-title">도메인과 용어·도메인분류의 원본이 다릅니다</div>
              도메인은 <strong>{{ pickLabel('domains') }}</strong
              >에서, 용어는 <strong>{{ pickLabel('terms') }}</strong
              >·도메인분류는 <strong>{{ pickLabel('domainClasses') }}</strong
              >에서 가져옵니다. 복사 후 도메인 계산 규칙으로 다시 계산해 물리명·타입이 달라지는 행을
              '검토필요'로 표시합니다.
            </div>
            <div class="alert-actions">
              <TfButton size="sm" @click="alignToDomains"
                >세 항목 모두 {{ pickLabel('domains') }}로</TfButton
              >
            </div>
          </div>
          <div v-for="w in bizWarnings" :key="w.code" class="alert alert-info card-inset">
            <TfIcon name="info" />
            <div class="alert-body">{{ w.message }}</div>
          </div>
        </div>

        <aside class="card sticky-top" aria-label="가져올 건수 미리보기">
          <div class="card-header">
            <div class="card-title"><TfIcon name="database" />가져올 건수</div>
            <span class="text-sm text-muted">{{ previewBusy ? '계산 중…' : '스냅샷 복사' }}</span>
          </div>
          <div class="list preview-list" data-testid="preview">
            <div class="list-item">
              <span>업무구분</span><span class="num">{{ count('BIZ_AREA') }}</span>
            </div>
            <div class="list-item">
              <span>용어</span><span class="num">{{ count('TERM') }}</span>
            </div>
            <div class="list-item">
              <span>도메인분류</span><span class="num">{{ count('DOMAIN_CLS') }}</span>
            </div>
            <div class="list-item">
              <span>도메인 <TfBadge v-if="c3Mixed" kind="warning">재검증</TfBadge></span
              ><span class="num">{{ count('DOMAIN') }}</span>
            </div>
            <div class="list-item">
              <span>코드구분</span><span class="num">{{ count('CODE_CLS') }}</span>
            </div>
            <div class="list-item">
              <span>코드</span><span class="num">{{ count('CODE') }}</span>
            </div>
            <div class="list-item">
              <span>기본컬럼</span><span class="num">{{ count('DEFAULT_COL') }}</span>
            </div>
          </div>
          <div class="divider" />
          <div class="stack-sm text-sm text-2">
            <span><TfIcon name="clock" size="sm" /> 보통 5초 안에 끝납니다</span>
            <span
              ><TfIcon name="info" size="sm" /> 이후 원본이 바뀌어도 자동 반영되지 않습니다</span
            >
            <span
              ><TfIcon name="history" size="sm" /> 행마다 출처(원본 프로젝트·ID)를 기록합니다</span
            >
            <span><TfIcon name="x" size="sm" /> 테이블·컬럼·이력·멤버는 가져오지 않습니다</span>
          </div>
        </aside>
      </div>
    </section>

    <!-- 3. 멤버 -->
    <section id="step-3" class="card wizard-section">
      <div class="card-header">
        <div class="card-title">
          <span class="count-pill">3</span>멤버
          <span class="text-sm text-muted">선택 · 나중에 설정에서 추가 가능</span>
        </div>
      </div>
      <div class="row wrap mb-3">
        <div class="dropdown w-320">
          <div class="input-wrap">
            <TfIcon name="search" />
            <input
              v-model="memberQ"
              class="input"
              placeholder="사용자 검색 (이름 · 아이디)"
              aria-label="멤버 검색"
              autocomplete="off"
            />
          </div>
          <div
            v-if="memberHits.length"
            class="dropdown-menu is-open w-320"
            role="listbox"
            aria-label="검색 결과"
          >
            <div class="dropdown-label">계정 검색 결과 {{ memberHits.length }}</div>
            <button
              v-for="u in memberHits"
              :key="u.id"
              class="dropdown-item"
              type="button"
              role="option"
              :disabled="isListed(u.id)"
              @click="choose(u)"
            >
              <span class="avatar sm">{{ u.userNm.slice(0, 1) }}</span
              ><span
                >{{ u.userNm }} <span class="text-muted">{{ u.loginId }}</span></span
              >
              <span class="dropdown-meta">{{ isListed(u.id) ? '추가됨' : '' }}</span>
            </button>
          </div>
        </div>
        <select v-model="memberRole" class="select w-160" aria-label="역할">
          <option value="EDITOR">편집자</option>
          <option value="VIEWER">조회자</option>
          <option value="ADMIN">프로젝트 관리자</option>
        </select>
        <TfButton :disabled="!memberPick" @click="addMember">추가</TfButton>
      </div>
      <table class="table table-compact">
        <tbody>
          <tr>
            <td>
              <span class="row"
                ><span class="avatar sm">{{ session.user?.userNm.slice(0, 1) }}</span
                >{{ session.user?.userNm }}
                <span class="mono text-muted">{{ session.user?.loginId }}</span></span
              >
            </td>
            <td>
              <TfBadge kind="accent">프로젝트 관리자</TfBadge>
              <span class="text-sm text-muted">생성자 · 자동</span>
            </td>
            <td class="col-menu" />
          </tr>
          <tr v-for="(m, i) in members" :key="m.userId">
            <td>
              <span class="row"
                ><span class="avatar sm">{{ m.userNm.slice(0, 1) }}</span
                >{{ m.userNm }} <span class="mono text-muted">{{ m.loginId }}</span></span
              >
            </td>
            <td>
              <select
                v-model="m.role"
                class="select select-sm w-160"
                :aria-label="`${m.userNm} 역할`"
              >
                <option v-for="r in ['ADMIN', 'EDITOR', 'VIEWER'] as const" :key="r" :value="r">
                  {{ ROLE_LABEL[r] }}
                </option>
              </select>
            </td>
            <td class="col-menu">
              <TfButton
                variant="ghost"
                size="sm"
                icon="x"
                icon-only
                :title="`${m.userNm} 제외`"
                :aria-label="`${m.userNm} 제외`"
                @click="members.splice(i, 1)"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <div class="wizard-foot">
      <RouterLink class="btn btn-ghost" to="/projects">취소</RouterLink>
      <span class="spacer" />
      <span class="text-sm text-muted" data-testid="footer-summary">{{ footerSummary }}</span>
      <TfButton
        variant="primary"
        icon="check"
        :disabled="!canCreate"
        :loading="creating"
        @click="create"
        >생성</TfButton
      >
    </div>
  </template>
</template>
