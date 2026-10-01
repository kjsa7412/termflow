<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import Lightbox from './components/Lightbox.vue';
import { NOT_FOUND, ROUTES } from './routes.js';
import { route, SiteLink } from './router.js';
import Features from './pages/FeaturesPage.vue';
import Home from './pages/HomePage.vue';
import Install from './pages/InstallPage.vue';
import NotFound from './pages/NotFoundPage.vue';
import Releases from './pages/ReleasesPage.vue';
import Screens from './pages/ScreensPage.vue';

/**
 * 껍데기 — 상단 바 · 본문 · 바닥글. 주소는 routes.ts 하나가 정한다.
 * **로그인·다운로드 단추가 없다**(CR-12 C1) — 제품은 각 회사가 설치한 서버에서 쓴다. 들이는 길은 설치 페이지의 문장이다.
 */
const PAGES = {
  '/': Home,
  '/features': Features,
  '/screens': Screens,
  '/install': Install,
  '/releases': Releases,
};
const meta = computed(() => ROUTES.find((r) => r.path === route.value.path) ?? null);
const Page = computed(() => PAGES[route.value.path as keyof typeof PAGES] ?? NotFound);
const nav = ROUTES.filter((r) => r.nav);
const version = __TF_VERSION__;

const main = ref<HTMLElement | null>(null);
const menuOpen = ref(false);
let first = true;
watch(
  () => route.value.path,
  async () => {
    document.title = meta.value?.title ?? NOT_FOUND.title;
    menuOpen.value = false;
    // 페이지를 넘기면 제목으로 포커스 — 화면 읽기 프로그램이 새 페이지를 안다. 첫 적재는 건드리지 않는다
    if (first) return void (first = false);
    await nextTick();
    main.value?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
  },
  { immediate: true },
);

// 테마: 저장값(localStorage) > 시스템 설정. index.html 인라인 스크립트가 그리기 전에 data-theme를 정한다
const dark = ref(false);
function isDark(): boolean {
  const t = document.documentElement.dataset['theme'];
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
}
function toggleTheme(): void {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset['theme'] = next;
  try {
    localStorage.setItem('tf-site-theme', next);
  } catch {
    /* 저장 불가 — 이번 방문만 */
  }
  dark.value = next === 'dark';
}
onMounted(() => {
  dark.value = isDark();
  matchMedia('(prefers-color-scheme: dark)').addEventListener(
    'change',
    () => (dark.value = isDark()),
  );
});
</script>

<template>
  <a class="skip" href="#main">본문으로</a>
  <header :class="['bar', { 'is-open': menuOpen }]">
    <div class="wrap bar__in">
      <SiteLink to="/" class="brand" aria-label="TermFlow 홈">
        <span class="brand__mark">TF</span><span>TermFlow</span>
      </SiteLink>
      <nav id="site-nav" class="bar__nav" aria-label="사이트">
        <SiteLink v-for="r in nav" :key="r.path" :to="r.path" class="bar__link">{{
          r.nav
        }}</SiteLink>
      </nav>
      <span class="sp" />
      <span class="bar__ver mono" title="이 사이트가 설명하는 판">v{{ version }}</span>
      <button
        type="button"
        class="icon-btn"
        :aria-label="dark ? '밝은 테마로' : '어두운 테마로'"
        :title="dark ? '밝은 테마로' : '어두운 테마로'"
        @click="toggleTheme"
      >
        <svg
          v-if="dark"
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
          <path
            d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"
          />
        </svg>
        <svg
          v-else
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
        </svg>
      </button>
      <button
        type="button"
        class="icon-btn bar__menu"
        aria-controls="site-nav"
        :aria-expanded="menuOpen"
        aria-label="메뉴"
        @click="menuOpen = !menuOpen"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path v-if="menuOpen" d="M6 6l12 12M18 6 6 18" />
          <path v-else d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
    </div>
  </header>
  <main id="main" ref="main" class="main" tabindex="-1">
    <component :is="Page" />
  </main>
  <footer class="foot">
    <div class="wrap foot__in">
      <span
        >TermFlow <span class="mono">v{{ version }}</span> · 이 사이트는 소개만 한다 — 로그인은 각
        회사가 설치한 서버에서</span
      >
      <span class="sp" />
      <SiteLink v-for="r in nav" :key="r.path" :to="r.path">{{ r.nav }}</SiteLink>
    </div>
  </footer>
  <Lightbox />
</template>
