import type { MemberRole } from '@termflow/shared';

/**
 * 사이드바 메뉴(설계서 §10.2, 목업 공통 사이드바). 그룹·항목 순서와 아이콘은 목업과 같다.
 * `to`가 없는 항목은 아직 제공하지 않는 화면(흐리게 표시·클릭 불가). `projectPath`는 `/projects/{key}` 아래 하위 경로.
 */
export interface NavItem {
  id: string;
  label: string;
  icon: string;
  /** 프로젝트 밖 절대 경로. */
  to?: string;
  /** 프로젝트 하위 경로(`''` = 홈). 현재 프로젝트가 있을 때만 표시. */
  projectPath?: string;
  /** 이 역할 이상일 때만 표시(프로젝트 역할). */
  minRole?: MemberRole;
  /** 제공 예정 화면(링크 없음). */
  pending?: boolean;
}

export interface NavGroup {
  id: 'design' | 'standards' | 'project' | 'system';
  title: string;
  /** 프로젝트 그룹이면 현재 프로젝트가 있을 때만 보인다(§10.2 "프로젝트 밖 화면에서는 숨김"). */
  scope: 'project' | 'system';
  items: NavItem[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: 'design',
    title: '설계',
    scope: 'project',
    items: [
      { id: 'home', label: '홈', icon: 'home', projectPath: '' },
      { id: 'tables', label: '테이블', icon: 'table', projectPath: '/tables', pending: true },
      {
        id: 'export',
        label: 'DDL 내보내기',
        icon: 'export',
        projectPath: '/export',
        pending: true,
      },
    ],
  },
  {
    id: 'standards',
    title: '표준 사전',
    scope: 'project',
    items: [
      { id: 'terms', label: '용어', icon: 'book', projectPath: '/standards/terms', pending: true },
      {
        id: 'domain-classes',
        label: '도메인분류',
        icon: 'tag',
        projectPath: '/standards/domain-classes',
        pending: true,
      },
      {
        id: 'domains',
        label: '도메인',
        icon: 'layers',
        projectPath: '/standards/domains',
        pending: true,
      },
      { id: 'codes', label: '코드', icon: 'code', projectPath: '/standards/codes', pending: true },
      {
        id: 'default-columns',
        label: '기본컬럼',
        icon: 'columns',
        projectPath: '/standards/default-columns',
        pending: true,
      },
      {
        id: 'approvals',
        label: '승인 큐',
        icon: 'check-circle',
        projectPath: '/standards/approvals',
        minRole: 'ADMIN',
        pending: true,
      },
    ],
  },
  {
    id: 'project',
    title: '프로젝트',
    scope: 'project',
    items: [
      {
        id: 'biz-areas',
        label: '업무구분',
        icon: 'folder',
        projectPath: '/biz-areas',
        pending: true,
      },
      { id: 'settings', label: '설정', icon: 'settings', projectPath: '/settings', pending: true },
    ],
  },
  {
    id: 'system',
    title: '시스템',
    scope: 'system',
    items: [
      { id: 'users', label: '사용자', icon: 'users', to: '/admin/users' },
      {
        id: 'admin-projects',
        label: '프로젝트',
        icon: 'database',
        to: '/admin/projects',
        pending: true,
      },
      { id: 'templates', label: '템플릿', icon: 'layers', to: '/admin/templates', pending: true },
    ],
  },
];
