/** 판 이력 — 판을 올릴 때 한 항목씩 더한다(원문: `docs/릴리스_노트_v*.md`). 사외 공개용 문장으로 줄여 쓴다. */
export interface Release {
  version: string;
  date: string;
  summary: string;
  items: string[];
}

export const RELEASES: Release[] = [
  {
    version: '1.1.0',
    date: '2026-10-01',
    summary: 'Linux 서버 설치형, 제품 안 설명서, 소개 사이트.',
    items: [
      'Linux 서버 설치 — install.sh 한 번(비밀값 난수 생성 · 부팅 시 기동 · 매일 백업 타이머), start.sh · backup.sh · restore.sh',
      '폐쇄망 오프라인 번들 — 소스와 이미지(app · postgres)를 파일 하나로, 인터넷 없이 설치·업그레이드',
      '설명서 화면(/manual) — 사용자 가이드를 제품 안에서, 로그인 전에도. 설치·운영 가이드는 시스템 관리자',
      '사용자 가이드에 실제 화면 그림(가상 데모 프로젝트)',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-09-30',
    summary: '첫 릴리스 — 프로젝트·표준 사전·자동완성 편집기·DDL·운영 스크립트.',
    items: [
      '프로젝트 단위로 표준 사전·테이블·멤버 분리, 생성 마법사(템플릿 · 다른 프로젝트 · 비움)',
      '표준 사전 7종 — 용어(승인 큐) · 도메인분류 · 도메인 · 코드구분 · 코드 · 기본컬럼 · 엑셀 일괄 등록',
      '테이블 편집기 — 논리명 Enter 자동완성, 인라인 용어 등록, 여러 줄 붙여넣기, 이력 · 복제 · 충돌 병합 · 임시 저장',
      'PostgreSQL DDL — 편집기 패널, 여러 테이블 내보내기(.sql · .zip · .tsv)',
      '역할 4종 · 서버 세션 + CSRF · 비밀번호 정책 · 단일 이미지 + compose · Windows 원클릭 실행 · 백업·복구',
    ],
  },
];
