<script setup lang="ts">
import { computed, ref } from 'vue';
import { EXAMPLES, resolve, type Verdict } from '../data/tryit.js';

/** 「직접 해 보기」 — 논리명 한 칸 → 조각 · 판정 · 물리명 · 타입 · DDL 한 줄(브라우저 안 축약 엔진, data/tryit.ts). */
const text = ref(EXAMPLES[0]!);
const r = computed(() => resolve(text.value));
const LABEL: Record<Verdict, { name: string; tone: string; note: string }> = {
  exact: {
    name: '표준',
    tone: 'ok',
    note: '표준 도메인과 정확히 일치 — 물리명·타입·코멘트를 그대로 채운다.',
  },
  code: {
    name: '코드',
    tone: 'info',
    note: '…코드로 끝나고 코드구분이 있다 — 연결하면 DDL 코멘트에 코드값이 들어간다.',
  },
  similar: {
    name: '비슷한 후보',
    tone: 'warn',
    note: '정확히 맞는 도메인이 없다 — ↑↓로 비슷한 도메인을 골라 Enter.',
  },
  composed: {
    name: '조합',
    tone: 'warn',
    note: '표준 도메인은 아니지만 용어 조각과 접미어 분류로 물리명·타입을 만든다.',
  },
  unregistered: {
    name: '미등록',
    tone: 'bad',
    note: '사전에 없는 조각이 있다 — 그 자리에서 물리약어를 넣어 등록(검토대기)하면 다시 계산한다.',
  },
  empty: { name: '입력 대기', tone: 'mute', note: '컬럼 논리명을 쓰고 Enter.' },
};
const label = computed(() => LABEL[r.value.verdict]);
const ddl = computed(() => {
  const x = r.value;
  if (!x.physical || x.physical.includes('?')) return null;
  const type = x.type ?? x.candidates[0]?.type;
  const phys = x.verdict === 'similar' && x.candidates[0] ? x.candidates[0].physical : x.physical;
  return type ? `${phys.padEnd(18)} ${type}` : null;
});
</script>

<template>
  <div class="try">
    <div class="try__input">
      <label for="try-logical">컬럼 논리명</label>
      <input
        id="try-logical"
        v-model="text"
        type="text"
        autocomplete="off"
        spellcheck="false"
        maxlength="30"
        placeholder="예: 교육과정번호"
      />
      <div class="try__chips" role="group" aria-label="예시">
        <button
          v-for="e in EXAMPLES"
          :key="e"
          type="button"
          :class="['chip', { 'is-on': e === text }]"
          @click="text = e"
        >
          {{ e }}
        </button>
      </div>
    </div>
    <div class="try__out" aria-live="polite">
      <div class="try__row">
        <span :class="['badge', `badge--${label.tone}`]">{{ label.name }}</span>
        <span class="try__note">{{ label.note }}</span>
      </div>
      <div v-if="r.pieces.length" class="try__pieces" aria-label="조각">
        <span v-for="(p, i) in r.pieces" :key="i" :class="['piece', { 'piece--bad': !p.physical }]">
          {{ p.kor }} <b class="mono">{{ p.physical ?? '미등록' }}</b>
        </span>
      </div>
      <dl class="try__kv">
        <div>
          <dt>물리명</dt>
          <dd class="mono">{{ r.physical ?? '—' }}</dd>
        </div>
        <div>
          <dt>타입</dt>
          <dd class="mono">{{ r.type ?? '—' }}</dd>
        </div>
      </dl>
      <ul
        v-if="r.verdict === 'similar' && r.candidates.length"
        class="try__list"
        aria-label="비슷한 도메인"
      >
        <li v-for="(c, i) in r.candidates" :key="c.logical" :class="{ 'is-on': i === 0 }">
          <span>{{ c.logical }}</span
          ><span class="mono">{{ c.physical }}</span
          ><span class="mono">{{ c.type }}</span>
        </li>
      </ul>
      <p v-if="r.code" class="try__code">
        코드구분 <b>{{ r.code.cls }}</b> · {{ r.code.codes.join(' · ') }}
      </p>
      <pre v-if="ddl" class="try__ddl"><code>{{ ddl }}</code></pre>
    </div>
    <p class="try__foot">
      브라우저 안에서 도는 축약판이다(가상 소사전 약 40개 용어). 제품은 프로젝트 표준 사전 전체와
      유사 도메인 검색으로 같은 판정을 서버에서 300ms 안에 낸다.
    </p>
  </div>
</template>
