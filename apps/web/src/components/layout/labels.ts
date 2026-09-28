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
