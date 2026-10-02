import type { MemberRole } from '@termflow/shared';

/** 화면 표기(목업 용어: 프로젝트 관리자·편집자·조회자, §7.2). */
export const ROLE_LABEL: Record<MemberRole, string> = {
  ADMIN: '프로젝트 관리자',
  EDITOR: '편집자',
  VIEWER: '조회자',
};

/** 날짜 표시(목업: 오늘 08:52 / 09-25 / 2026-06-30). 입력은 서버 로컬 ISO(`2026-09-28T08:52:00`). */
export function shortDateTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '없음';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (d.toDateString() === now.toDateString())
    return `오늘 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 테이블 이력 요약에서 동작 이름과 겹치는 앞부분을 뺀다(CR-15 C14). 서버 요약은 `확정(FINAL)`·`확정 해제(DRAFT)`·`복제: …`처럼
 * 동작을 되풀이해 "확정 · 확정(FINAL)", "복제 · 복제: …"로 보였다. 이미 저장된 이력에도 맞도록 화면에서 처리한다.
 */
export function historySummary(summary: string | null | undefined): string {
  const s = (summary ?? '').trim();
  for (const head of ['확정 해제(DRAFT)', '확정(FINAL)', '복제:']) {
    if (s.startsWith(head)) return s.slice(head.length).replace(/^[\s:·]+/, '');
  }
  return s;
}
