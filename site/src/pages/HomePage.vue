<script setup lang="ts">
import Shot from '../components/Shot.vue';
import TryIt from '../components/TryIt.vue';
import { SiteLink } from '../router.js';

/** 홈 — 한 문장 · 세 가지 · 직접 해 보기 · 한 흐름(측정값) · 역할 넷 · 두 배치 · 더 보기. 광고 문구 대신 제품의 말로. */
const ROLES = [
  {
    name: '시스템 관리자',
    scope: '전체',
    does: '계정 발급, 프로젝트 생성·보관·삭제, 템플릿 관리·게시',
  },
  {
    name: '프로젝트 관리자',
    scope: '프로젝트',
    does: '멤버·업무구분, 표준 사전 편집·일괄 등록·승인, 확정 해제',
  },
  {
    name: '편집자',
    scope: '프로젝트',
    does: '테이블 설계·저장·확정, 미등록 용어 인라인 등록, DDL',
  },
  { name: '조회자', scope: '프로젝트', does: '프로젝트 전체 조회, DDL 미리보기·복사·다운로드' },
];
const FLOW = [
  { k: '새 테이블', v: '업무구분을 고르면 접두어(ED_)로 시작한다' },
  { k: '논리 테이블명', v: '교육신청이력 → 물리명 ED_EDU_REQ_HST 제안' },
  { k: '컬럼 논리명 × 10', v: '이름을 쓰고 Enter — 표준으로 물리명·타입·코멘트, 다음 행으로' },
  { k: 'PK · 저장', v: 'Ctrl+S — 버전과 스냅샷이 남는다' },
  { k: 'DDL 복사', v: '오른쪽 패널의 [복사] 또는 .sql 다운로드' },
];
</script>

<template>
  <div class="wrap">
    <section class="hero">
      <div class="hero__text">
        <p class="eyebrow">TermFlow · 표준 용어 기반 테이블 설계 · DDL 생성</p>
        <h1 tabindex="-1">용어에서 DDL까지,<br />끊김 없는 한 흐름</h1>
        <p class="lead">
          표준 사전(용어·도메인·코드)을 <b>프로젝트마다</b> 두고, 컬럼
          <b>논리명을 쓰고 Enter</b> 하면 표준으로 물리명·타입·코멘트가 채워진다. 설계가 끝나면
          <b>PostgreSQL DDL</b>을 복사하거나 내려받는다.
        </p>
        <div class="cta">
          <SiteLink to="/screens" class="btn btn--accent">화면 보기 →</SiteLink>
          <SiteLink to="/install" class="btn">설치 안내</SiteLink>
        </div>
      </div>
      <div class="hero__shot">
        <Shot id="08-editor" :caption="false" eager />
      </div>
    </section>

    <section class="sec">
      <h2 class="sec__title">세 가지</h2>
      <div class="grid3">
        <article class="card">
          <h3>표준 사전</h3>
          <p>
            용어 ↔ 물리약어, 도메인(조각 + 접미어 분류 → 타입), 코드, 기본컬럼. 템플릿에서 복사해
            <b>프로젝트마다 독립 사본</b>으로 둔다 — 한 프로젝트를 고쳐도 다른 프로젝트는 그대로다.
          </p>
        </article>
        <article class="card">
          <h3>자동완성 설계</h3>
          <p>
            논리명 Enter → <b>표준 · 비슷한 후보 · 조합 · 코드 · 미등록</b>. 사전에 없는 조각은 그
            자리에서 물리약어를 넣어 등록(검토대기)하고 바로 쓴다. 관리자는 승인 큐에서 처리한다.
          </p>
        </article>
        <article class="card">
          <h3>DDL</h3>
          <p>
            저장 전에도 보이는 DDL 패널, 여러 테이블 내보내기(.sql · .zip · .tsv). TermFlow는 DDL을
            업무 DB에서
            <b>실행하지 않는다</b> — 담당 DBA가 적용한다.
          </p>
        </article>
      </div>
    </section>

    <section class="sec">
      <h2 class="sec__title">직접 해 보기 — 컬럼 이름 하나</h2>
      <p class="sec__lead">
        편집기 그리드의 논리명 칸 하나를 떼어 왔다. 예시를 누르거나 직접 써 본다.
      </p>
      <TryIt />
    </section>

    <section class="sec">
      <h2 class="sec__title">한 흐름 — 새 테이블 하나, 컬럼 열</h2>
      <ol class="flow">
        <li v-for="(f, i) in FLOW" :key="f.k">
          <span class="flow__n">{{ i + 1 }}</span>
          <b>{{ f.k }}</b>
          <span>{{ f.v }}</span>
        </li>
      </ol>
      <div class="stats">
        <div class="stat">
          <b>11 · 4 · 1</b>
          <span
            >입력 · 클릭 · 화면 이동<br /><small>기준 ≤12 · ≤6 · ≤1, 브라우저 E2E 실측</small></span
          >
        </div>
        <div class="stat">
          <b>279.7ms</b>
          <span>자동완성 p95, 동시 20명<br /><small>기준 ≤300ms · 단독 83.8ms</small></span>
        </div>
        <div class="stat">
          <b>33 / 33</b>
          <span
            >이관 테이블 DDL을 PostgreSQL에서 실행<br /><small>릴리스마다 회귀 검증</small></span
          >
        </div>
      </div>
    </section>

    <section class="sec">
      <h2 class="sec__title">역할 넷</h2>
      <div class="table-box">
        <table class="tbl">
          <thead>
            <tr>
              <th>역할</th>
              <th>범위</th>
              <th>하는 일</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in ROLES" :key="r.name">
              <th scope="row">{{ r.name }}</th>
              <td>{{ r.scope }}</td>
              <td>{{ r.does }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="note">멤버가 아닌 프로젝트는 보이지 않는다 — 주소로 들어가도 "찾을 수 없음".</p>
    </section>

    <section class="sec">
      <h2 class="sec__title">두 배치</h2>
      <div class="grid2">
        <article class="card">
          <h3>Windows PC 한 대</h3>
          <p>
            Docker Desktop + <span class="mono">start.bat</span> 더블클릭. Docker·설정 검사 → DB →
            초기 데이터 → 앱 → 브라우저까지 한 번에.
          </p>
        </article>
        <article class="card">
          <h3>Linux 서버</h3>
          <p>
            <span class="mono">sudo ./install.sh</span> 한 번 — 비밀값 난수 생성, 부팅 시 기동, 매일
            백업. 인터넷이 없으면 소스와 이미지를 묶은 <b>오프라인 번들</b> 파일 하나를 반입한다.
          </p>
        </article>
      </div>
      <p class="more"><SiteLink to="/install">설치 절차 보기 →</SiteLink></p>
    </section>

    <section class="sec">
      <h2 class="sec__title">더 보기</h2>
      <div class="grid3">
        <SiteLink to="/features" class="card card--link">
          <h3>기능</h3>
          <p>프로젝트·권한 · 표준 사전 7종 · 편집기 · DDL · 설명서 · 운영. 하지 않는 것.</p>
        </SiteLink>
        <SiteLink to="/screens" class="card card--link">
          <h3>화면 18장</h3>
          <p>가상 데모 프로젝트(교육 운영 관리)로 찍은 v1.1의 실제 화면.</p>
        </SiteLink>
        <SiteLink to="/releases" class="card card--link">
          <h3>판 이력</h3>
          <p>판마다 무엇이 바뀌었나.</p>
        </SiteLink>
      </div>
    </section>
  </div>
</template>
