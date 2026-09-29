import { computed } from 'vue';
import { useRoute } from 'vue-router';
import type { ValidationIssue } from '@termflow/shared';
import { ApiError } from '../api/client.js';
import { useSessionStore } from '../stores/session.js';

/**
 * 현재 프로젝트(경로 `:projectKey`)와 쓰기 권한(§7.3): 프로젝트 관리자(시스템 관리자 포함)만 표준 쓰기,
 * 보관 프로젝트는 읽기 전용, 템플릿은 시스템 관리자만(§4.6). 화면은 조회자에게 쓰기 컨트롤을 숨긴다(T6.12 DoD).
 */
export function useProject() {
  const route = useRoute();
  const session = useSessionStore();
  const key = computed(() => String(route.params['projectKey'] ?? ''));
  const project = computed(() => session.projects.find((p) => p.key === key.value) ?? null);
  const isTemplate = computed(() => project.value?.kind === 'TEMPLATE');
  const archived = computed(() => project.value?.status === 'ARCHIVED');
  const isAdmin = computed(() => session.isSysAdmin || project.value?.role === 'ADMIN');
  const canWrite = computed(
    () => isAdmin.value && !archived.value && (!isTemplate.value || session.isSysAdmin),
  );
  return { key, project, isTemplate, archived, isAdmin, canWrite, session };
}

/** 오류 → 사용자 문구(ProblemDetail errors[]가 있으면 필드 메시지 연결). */
export function errMsg(e: unknown, fallback: string): string {
  if (e instanceof ApiError && e.problem) {
    const errs = (e.problem['errors'] as ValidationIssue[] | undefined) ?? [];
    return errs.length ? errs.map((x) => x.message).join(' · ') : (e.problem.detail ?? fallback);
  }
  return fallback;
}

/** 오류 목록(422 errors[]) — 인라인 표시용. */
export function errIssues(e: unknown): ValidationIssue[] {
  if (e instanceof ApiError && e.problem) {
    return (e.problem['errors'] as ValidationIssue[] | undefined) ?? [];
  }
  return [];
}

export const fmtNum = (n: number | null | undefined) => (n ?? 0).toLocaleString('ko-KR');
/** `2026-09-28T12:30:05` → `2026-09-28 12:30`. */
export const fmtTs = (s: string | null | undefined) => (s ? s.slice(0, 16).replace('T', ' ') : '—');
