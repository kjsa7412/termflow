<script setup lang="ts">
import Shot from '../components/Shot.vue';
import { SCREENS, type Screen } from '../data/screens.js';

/** 화면 — 묶음별 그림. 누르면 크게(← → 로 넘긴다). */
const GROUPS: Screen['group'][] = ['시작', '테이블 설계', '표준 사전', 'DDL', '관리'];
const byGroup = (g: Screen['group']) => SCREENS.filter((s) => s.group === g);
const ver = __TF_VERSION__.split('.').slice(0, 2).join('.');
</script>

<template>
  <div class="wrap page">
    <h1 tabindex="-1">화면</h1>
    <p class="lead">
      v{{ ver }}의 실제 화면 {{ SCREENS.length }}장. 내용은 <b>가상 데모 프로젝트</b>(교육 운영 관리
      · 업무구분 교육·자산 · 사람 김지현·이도윤·최유진·박서연)이고, 표준 사전은 기본 템플릿이다.
      그림을 누르면 크게 보인다.
    </p>
    <section v-for="g in GROUPS" :key="g" class="sec">
      <h2 class="sec__title">{{ g }}</h2>
      <div class="gallery">
        <Shot v-for="s in byGroup(g)" :id="s.id" :key="s.id" />
      </div>
    </section>
  </div>
</template>
