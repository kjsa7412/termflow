<script setup lang="ts">
import Shot from '../components/Shot.vue';
import { GROUPS, SCREENS, type GroupKey } from '../data/screens.js';

/** 화면 — 묶음별로 그림 + 설명(제목·역할·요점). 그림을 누르면 크게(← → 로 넘긴다). */
const byGroup = (g: GroupKey) => SCREENS.filter((s) => s.group === g);
const ver = __TF_VERSION__.split('.').slice(0, 2).join('.');
</script>

<template>
  <div class="wrap page">
    <h1 tabindex="-1">화면</h1>
    <p class="lead">
      v{{ ver }}의 실제 화면 {{ SCREENS.length }}장. 목업이 아니다 — 화면은 진짜이고 내용만
      <b>가상 데모 프로젝트</b>(교육 운영 관리 · 업무구분 교육·자산 · 사람
      김지현·이도윤·최유진·박서연)다. 표준 사전은 기본 템플릿이다. 그림을 누르면 크게 보인다.
    </p>
    <nav class="toc" aria-label="화면 묶음">
      <a v-for="g in GROUPS" :key="g.key" :href="`#${g.slug}`">{{ g.key }}</a>
    </nav>
    <section v-for="g in GROUPS" :id="g.slug" :key="g.key" class="sec">
      <h2 class="sec__title">{{ g.title }}</h2>
      <p class="sec__lead">{{ g.lead }}</p>
      <div class="shots">
        <article v-for="s in byGroup(g.key)" :key="s.id" class="shots__item">
          <Shot :id="s.id" :caption="false" />
          <div class="shots__txt">
            <h3>
              {{ s.title }}
              <span v-if="s.role" class="shots__role">{{ s.role }}</span>
            </h3>
            <p>{{ s.desc }}</p>
            <ul>
              <li v-for="p in s.points" :key="p">{{ p }}</li>
            </ul>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>
