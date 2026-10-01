<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import books from 'virtual:termflow-manual';
import { useSessionStore } from '../stores/session.js';
import { useToastStore } from '../stores/toast.js';
import EmptyState from '../components/ui/EmptyState.vue';
import TfIcon from '../components/ui/TfIcon.vue';

/**
 * 설명서(T12.5, CR-12 C4): `docs/사용자_가이드.md`·`docs/설치_운영_가이드.md`를 빌드 때 HTML로 바꾼 것(`build/manual.ts`)을 그린다.
 * 사용자 가이드는 로그인 전에도 열람(라우트 `meta.public`), 설치·운영 가이드는 시스템 관리자만(목록에서 감추고 주소로 와도 안내).
 * 왼쪽: 책 목록 + 현재 책 목차(스크롤 위치의 절 강조). 본문 안 링크: 다른 책·화면 경로는 라우터로, `#절`은 그 절로 스크롤.
 */
const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const toast = useToastStore();

const visible = computed(() => books.filter((b) => b.audience === 'all' || session.isSysAdmin));
const askedId = computed(() => (route.params['id'] ? String(route.params['id']) : ''));
const book = computed(() => books.find((b) => b.id === askedId.value) ?? null);
const denied = computed(() => book.value?.audience === 'sysadmin' && !session.isSysAdmin);
const shortTitle = (t: string) => t.replace(/^TermFlow\s*/, '');

// 책을 고르지 않으면(`/manual`) 첫 권으로
watch(
  askedId,
  (id) => {
    if (!id && visible.value[0])
      void router.replace(`/manual/${encodeURIComponent(visible.value[0].id)}`);
  },
  { immediate: true },
);
watch(
  book,
  (b) => {
    document.title = b ? `TermFlow · ${shortTitle(b.title)}` : 'TermFlow · 설명서';
  },
  { immediate: true },
);

const body = ref<HTMLElement | null>(null);
const cur = ref<string | null>(null);

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
function scrollToHash(hash: string): void {
  if (!hash) {
    window.scrollTo(0, 0);
    return;
  }
  document.getElementById(decode(hash.slice(1)))?.scrollIntoView({ block: 'start' });
}

/** 코드 블록에 [복사] 단추를 붙인다(설치 명령 등). */
function enhance(root: HTMLElement): void {
  for (const pre of root.querySelectorAll<HTMLElement>('pre.doc-pre')) {
    if (pre.querySelector('.doc-copy')) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost btn-sm doc-copy';
    btn.textContent = '복사';
    btn.setAttribute('aria-label', '코드 복사');
    pre.appendChild(btn);
  }
}

let observer: IntersectionObserver | null = null;
function spy(root: HTMLElement): void {
  observer?.disconnect();
  if (typeof IntersectionObserver === 'undefined') return;
  const heads = [...root.querySelectorAll<HTMLElement>('h2[id], h3[id]')];
  const seen = new Set<string>();
  observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) seen.add(e.target.id);
        else seen.delete(e.target.id);
      }
      // 화면에 보이는 첫 제목, 없으면 화면 위로 지나간 마지막 제목
      const first = heads.find((h) => seen.has(h.id));
      if (first) cur.value = first.id;
      else {
        const above = heads.filter((h) => h.getBoundingClientRect().top < 0).pop();
        if (above) cur.value = above.id;
      }
    },
    { rootMargin: '-56px 0px -55% 0px' },
  );
  heads.forEach((h) => observer!.observe(h));
}

watch(
  [book, denied, body],
  async () => {
    await nextTick();
    const root = body.value;
    if (!root || !book.value || denied.value) return;
    enhance(root);
    spy(root);
    cur.value = book.value.toc[0]?.slug ?? null;
    scrollToHash(route.hash);
  },
  { immediate: true },
);
watch(
  () => route.hash,
  (h) => scrollToHash(h),
);
onBeforeUnmount(() => observer?.disconnect());

function goto(slug: string): void {
  // vue-router가 hash를 인코딩한다 — 원문 그대로 넘긴다
  void router.replace({ hash: `#${slug}` });
  // 같은 hash를 다시 누르면 watch가 돌지 않는다 — 직접 스크롤
  document.getElementById(slug)?.scrollIntoView({ block: 'start' });
  cur.value = slug;
}

async function onClick(e: MouseEvent): Promise<void> {
  const t = e.target as HTMLElement;
  const copy = t.closest<HTMLButtonElement>('button.doc-copy');
  if (copy) {
    const code = copy.parentElement?.querySelector('code')?.textContent ?? '';
    try {
      await navigator.clipboard.writeText(code);
      toast.success('복사했습니다');
    } catch {
      toast.error('복사하지 못했습니다(브라우저 권한). 직접 선택해 복사하세요');
    }
    return;
  }
  const img = t.closest<HTMLImageElement>('img');
  if (img) {
    window.open(img.src, '_blank', 'noopener');
    return;
  }
  const a = t.closest<HTMLAnchorElement>('a[href]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  const href = a.getAttribute('href') ?? '';
  if (href.startsWith('#')) {
    e.preventDefault();
    goto(decode(href.slice(1)));
  } else if (a.dataset['route']) {
    e.preventDefault();
    void router.push(href);
  }
}
</script>

<template>
  <div class="manual">
    <nav class="manual-nav" aria-label="설명서">
      <div class="manual-cap">설명서</div>
      <RouterLink
        v-for="b in visible"
        :key="b.id"
        :to="`/manual/${encodeURIComponent(b.id)}`"
        class="manual-book"
        :aria-current="b.id === askedId ? 'page' : undefined"
        :title="b.desc"
      >
        <TfIcon :name="b.icon" />
        <span>{{ shortTitle(b.title) }}</span>
        <span v-if="b.audience === 'sysadmin'" class="manual-tag">관리자</span>
      </RouterLink>
      <div v-if="book && !denied && book.toc.length" class="manual-toc" aria-label="목차">
        <a
          v-for="t in book.toc"
          :key="t.slug"
          :href="`#${encodeURIComponent(t.slug)}`"
          :class="{ 'is-h3': t.level === 3 }"
          :aria-current="cur === t.slug ? 'true' : undefined"
          :title="t.text"
          @click.prevent="goto(t.slug)"
          >{{ t.text }}</a
        >
      </div>
    </nav>
    <div class="manual-body">
      <EmptyState
        v-if="askedId && !book"
        icon="alert-circle"
        title="설명서를 찾을 수 없습니다"
        desc="주소가 잘못되었습니다. 왼쪽 목록에서 고르세요."
      />
      <EmptyState
        v-else-if="denied"
        icon="lock"
        title="시스템 관리자용 설명서입니다"
        :desc="
          session.isLoggedIn
            ? '설치·운영 가이드는 시스템 관리자만 볼 수 있습니다.'
            : '시스템 관리자로 로그인하면 볼 수 있습니다.'
        "
      >
        <RouterLink
          v-if="!session.isLoggedIn"
          class="btn btn-secondary"
          :to="{ path: '/login', query: { next: route.fullPath } }"
          >로그인</RouterLink
        >
      </EmptyState>
      <template v-else-if="book">
        <div class="manual-crumb">설명서 › {{ shortTitle(book.title) }}</div>
        <!-- 빌드 때 저장소 docs/*.md를 변환한 HTML(원문 HTML은 이스케이프, build/manual.ts) — 사용자 입력이 아니다 -->
        <!-- eslint-disable-next-line vue/no-v-html -->
        <article
          ref="body"
          class="doc"
          data-testid="manual-body"
          @click="onClick"
          v-html="book.html"
        />
      </template>
    </div>
  </div>
</template>
