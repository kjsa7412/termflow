/**
 * 주소 다섯 — 라우터·상단 바·바닥글·주소별 사본(tools/postbuild.mjs)·sitemap이 **이 목록 하나**를 본다.
 * 컴포넌트를 싣지 않는다(node가 그대로 import한다).
 */
export interface SiteRoute {
  path: string;
  /** 상단 바 이름(null = 홈, 상단 바에 없음). */
  nav: string | null;
  title: string;
  description: string;
}

export const ROUTES: SiteRoute[] = [
  {
    path: '/',
    nav: null,
    title: 'TermFlow — 용어에서 DDL까지, 끊김 없는 한 흐름',
    description:
      '표준 용어로 컬럼을 자동완성해 테이블을 설계하고 PostgreSQL DDL까지 만드는 다중 사용자·프로젝트 기반 데이터 표준 설계 서비스.',
  },
  {
    path: '/features',
    nav: '기능',
    title: '기능 · TermFlow',
    description:
      '프로젝트·권한, 표준 사전 7종, 자동완성 테이블 편집기, DDL 내보내기, 제품 안 설명서, 운영 — 무엇을 하고 무엇을 하지 않는가.',
  },
  {
    path: '/screens',
    nav: '화면',
    title: '화면 · TermFlow',
    description: 'v1.1의 실제 화면 18장 — 가상 데모 프로젝트(교육 운영 관리)로 찍었다.',
  },
  {
    path: '/install',
    nav: '설치',
    title: '설치 · TermFlow',
    description:
      'Windows PC(start.bat)와 Linux 서버(install.sh, 폐쇄망 오프라인 번들) 설치, 첫 로그인, 백업·업그레이드.',
  },
  {
    path: '/releases',
    nav: '판 이력',
    title: '판 이력 · TermFlow',
    description: '판마다 무엇이 바뀌었나.',
  },
];

export const NOT_FOUND = { title: '없는 주소 · TermFlow', description: '없는 주소입니다.' };
