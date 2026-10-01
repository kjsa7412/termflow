<script setup lang="ts">
import { RELEASES } from '../data/releases.js';

/** 판 이력 — 새 판이 위. */
</script>

<template>
  <div class="wrap page">
    <h1 tabindex="-1">판 이력</h1>
    <p class="lead">
      판마다 무엇이 바뀌었나. 판 번호는 이미지 태그(<span class="mono">termflow-app:&lt;판&gt;</span
      >)와 같다.
    </p>
    <ol class="rel">
      <li v-for="r in RELEASES" :key="r.version" class="rel__item">
        <div class="rel__head">
          <h2 :id="`v${r.version}`" class="mono">v{{ r.version }}</h2>
          <time :datetime="r.date">{{ r.date }}</time>
        </div>
        <p class="rel__sum">{{ r.summary }}</p>
        <ul class="list">
          <li v-for="it in r.items" :key="it">{{ it }}</li>
        </ul>
      </li>
    </ol>
  </div>
</template>
