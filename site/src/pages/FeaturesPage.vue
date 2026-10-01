<script setup lang="ts">
import Shot from '../components/Shot.vue';
import { SiteLink } from '../router.js';

/** 기능 — 영역마다 그림 한 장과 할 수 있는 일. 끝에 하지 않는 것. */
const SECTIONS = [
  {
    id: 'project',
    title: '프로젝트·권한',
    shot: '13-project-new',
    points: [
      '프로젝트(작업 공간)마다 표준 사전·업무구분·테이블·멤버를 따로 둔다',
      '생성 마법사 한 페이지 3단계 — 표준 항목마다 원본을 템플릿 / 다른 프로젝트 / 비움 중에서, 건수 미리보기',
      '역할 넷(시스템 관리자 · 프로젝트 관리자 · 편집자 · 조회자), 비멤버 프로젝트는 404',
      '보관(쓰기 잠금·복원 가능) → 삭제(키 다시 입력)',
    ],
  },
  {
    id: 'standards',
    title: '표준 사전 7종',
    shot: '05-domains',
    points: [
      '용어(한글 ↔ 물리약어, 승인·검토대기·반려) · 도메인분류(접미어 → 타입) · 도메인(명칭 조각 → 논리명·물리명·타입 자동 계산)',
      '코드구분·코드(업무구분 아래 트리) · 기본컬럼 세트(최초·최종 등록자·일시 등)',
      '엑셀 일괄 등록 — 템플릿 내려받기 → 업로드 → 미리보기(신규·갱신·오류·동일) → 적용',
      '승인 큐 — 편집자가 편집기에서 등록한 용어를 승인·약어 고쳐 승인·반려. 모든 변경은 감사 이력',
    ],
  },
  {
    id: 'editor',
    title: '테이블 편집기',
    shot: '09-autocomplete',
    points: [
      '논리명 Enter 자동완성 — 표준(정확 일치) · 비슷한 후보 목록 · 용어 조합 · 코드성 컬럼(코드구분 후보)',
      '미등록 조각은 행 아래 인라인 카드로 등록 → 자동으로 다시 계산',
      '엑셀에서 논리명 여러 줄 붙여넣기 → 한 번에 자동완성. 테이블 물리명도 접두어 + 분절로 제안',
      '저장마다 버전·스냅샷(이력·복원), 복제(다른 프로젝트로도), 동시 저장 충돌 병합, 브라우저 임시 저장, DRAFT → FINAL',
      '키보드만으로 전 흐름 — Enter · Tab · ↑↓ · Alt+↑↓ · Esc · Ctrl+S · Ctrl+D',
    ],
  },
  {
    id: 'ddl',
    title: 'DDL',
    shot: '11-ddl-export',
    points: [
      'PostgreSQL DDL — 식별자 규칙, 테이블·컬럼 코멘트, 기본값, 코드성 컬럼 표현(코멘트 요약 · CHECK), DROP IF EXISTS',
      '편집기 오른쪽 패널 — 저장 전 편집본도 미리보기, 경고를 누르면 그 행으로',
      '여러 테이블 내보내기 — 단일 .sql · 업무구분 폴더별 .zip · 정보 추출 .tsv(테이블·컬럼 정의 표), 내보내기 기록',
    ],
  },
  {
    id: 'manual',
    title: '제품 안 설명서',
    shot: '18-manual',
    points: [
      '사용자 가이드를 제품 화면에서 — 상단 바 ? 단추, 로그인 화면의 링크(로그인 전에도 열린다)',
      '역할별 사용법과 화면 그림, 목차·절 링크. 설치·운영 가이드는 시스템 관리자에게만',
    ],
  },
];
</script>

<template>
  <div class="wrap page">
    <h1 tabindex="-1">기능</h1>
    <p class="lead">
      TermFlow는 데이터 표준(용어·도메인·코드)을 지키며 테이블을 설계하고 DDL을 얻는 일 하나에
      집중한다.
    </p>
    <nav class="toc" aria-label="이 페이지">
      <a v-for="s in SECTIONS" :key="s.id" :href="`#${s.id}`">{{ s.title }}</a>
      <a href="#ops">운영</a>
      <a href="#not">하지 않는 것</a>
    </nav>

    <section
      v-for="(s, i) in SECTIONS"
      :id="s.id"
      :key="s.id"
      :class="['feat', { 'feat--rev': i % 2 === 1 }]"
    >
      <div class="feat__text">
        <h2>{{ s.title }}</h2>
        <ul class="list">
          <li v-for="p in s.points" :key="p">{{ p }}</li>
        </ul>
      </div>
      <Shot :id="s.shot" />
    </section>

    <section id="ops" class="sec">
      <h2>운영</h2>
      <div class="grid3">
        <article class="card">
          <h3>설치 한 번</h3>
          <p>
            단일 앱 이미지 + PostgreSQL 17(compose). Windows는 start.bat, Linux는 install.sh. 기동할
            때 스키마를 자동으로 맞춘다.
          </p>
        </article>
        <article class="card">
          <h3>백업·복구</h3>
          <p>
            <span class="mono">pg_dump -Fc</span> 매일·14일 보관(작업 스케줄러 · systemd 타이머),
            복구 스크립트 한 줄.
          </p>
        </article>
        <article class="card">
          <h3>로그·상태</h3>
          <p>
            일 단위 로그 30일, <span class="mono">/health</span>(DB 포함) ·
            <span class="mono">/metrics</span>. 비밀번호·세션 값은 로그에서 가린다.
          </p>
        </article>
      </div>
    </section>

    <section id="not" class="sec">
      <h2>하지 않는 것</h2>
      <ul class="list list--x">
        <li>DDL을 업무 DB에 실행하지 않는다 — 생성만 하고, 적용은 담당 DBA가 한다</li>
        <li>PostgreSQL 외 방언(Oracle·MySQL)은 v1.x에서 만들지 않는다</li>
        <li>
          표준을 고쳐도 이미 저장된 테이블을 몰래 바꾸지 않는다 — 편집기에서 경고와 [재적용]으로
        </li>
        <li>외부 서비스로 데이터를 보내지 않는다 — 설치한 서버 안에서만 돈다</li>
      </ul>
      <p class="more"><SiteLink to="/screens">화면 18장 보기 →</SiteLink></p>
    </section>
  </div>
</template>
