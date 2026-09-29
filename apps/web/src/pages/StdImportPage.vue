<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { IMPORT_KINDS, type ImportKind } from '@termflow/shared';
import BulkImportFlow from '../components/std/BulkImportFlow.vue';
import EmptyState from '../components/ui/EmptyState.vue';
import { useProject } from '../composables/useProject.js';

/**
 * 일괄 등록(`/projects/{key}/standards/{kind}/import`, 목업 04b, §9.4). kind 5종이 같은 흐름(BulkImportFlow)을 쓴다.
 * 적용 후 [목록으로]는 해당 사전 화면으로 돌아간다(이동 1, S1 엑셀).
 */
const route = useRoute();
const router = useRouter();
const { key, project, canWrite } = useProject();
const INFO: Record<ImportKind, { title: string; back: string; header: string }> = {
  terms: {
    title: '용어',
    back: 'standards/terms',
    header: '한글용어 · 물리약어 · 설명 · 동의어참조',
  },
  'domain-classes': {
    title: '도메인분류',
    back: 'standards/domain-classes',
    header: '접미어 · 명칭 · 타입 · 길이 · 스케일 · 설명',
  },
  domains: {
    title: '도메인',
    back: 'standards/domains',
    header: '명칭1~7 · 수기타입 · 수기길이 · 수기스케일 (논리명·물리명·타입은 L1 계산)',
  },
  'code-classes': {
    title: '코드',
    back: 'standards/codes',
    header: '업무구분코드 · 코드구분 · 코드구분명 · 코드 · 코드명 · 정렬순서',
  },
  'biz-areas': {
    title: '업무구분',
    back: 'biz-areas',
    header: '업무구분코드 · 업무구분명 · 테이블접두어 · 정렬 · 사용여부 · 설명',
  },
};
const kind = computed(() => {
  const k = String(route.params['kind'] ?? '');
  return (IMPORT_KINDS as readonly string[]).includes(k) ? (k as ImportKind) : null;
});
const info = computed(() => (kind.value ? INFO[kind.value] : null));
const backTo = computed(() => `/projects/${key.value}/${info.value?.back ?? ''}`);
</script>

<template>
  <EmptyState v-if="!kind || !info" icon="upload" title="일괄 등록 종류가 아닙니다">
    <RouterLink class="btn btn-secondary" :to="`/projects/${key}`">프로젝트 홈으로</RouterLink>
  </EmptyState>
  <template v-else>
    <div class="page-header">
      <div>
        <div class="breadcrumb">
          <RouterLink :to="`/projects/${key}`">{{ project?.nm ?? key }}</RouterLink
          ><span>›</span><span>표준 사전</span><span>›</span
          ><RouterLink :to="backTo">{{ info.title }}</RouterLink
          ><span>›</span><span>일괄 등록</span>
        </div>
        <h1 class="page-title">{{ info.title }} 일괄 등록</h1>
        <p class="page-desc">
          엑셀 헤더: <span class="mono">{{ info.header }}</span
          >. 키가 없으면 <span class="badge badge-new">신규</span>, 있으면
          <span class="badge badge-update">갱신</span>, 규칙 위반 행은
          <span class="badge badge-error">오류</span>로 제외되고 같은 값은
          <span class="badge badge-gray">동일</span>로 건너뜁니다.
        </p>
      </div>
    </div>
    <div v-if="!canWrite" class="alert alert-warning">
      <div class="alert-body">
        프로젝트 관리자만 일괄 등록할 수 있습니다(보관·템플릿 프로젝트는 읽기 전용).
      </div>
    </div>
    <BulkImportFlow
      v-else
      :project-key="key"
      :kind="kind"
      :title="info.title"
      @cancel="router.push(backTo)"
    />
  </template>
</template>
