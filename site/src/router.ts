import { computed, defineComponent, h, ref, type PropType } from 'vue';

/**
 * 작은 history 라우터(CR-12 C2): 주소 다섯이라 vue-router를 쓰지 않는다. base(`__TF_BASE__`)를 안다.
 * `navigate()`는 pushState + 맨 위로 스크롤, 뒤로 가기는 popstate. 같은 주소의 `#절`은 브라우저에 맡긴다.
 */
const BASE = __TF_BASE__.replace(/\/$/, '');

function current(): string {
  let p = decodeURI(location.pathname);
  if (BASE && p.startsWith(BASE)) p = p.slice(BASE.length) || '/';
  p = p.replace(/\/index\.html$/, '/');
  return p.length > 1 ? p.replace(/\/$/, '') : '/';
}

const path = ref(typeof location === 'undefined' ? '/' : current());
if (typeof window !== 'undefined')
  window.addEventListener('popstate', () => (path.value = current()));

export const route = computed(() => ({ path: path.value }));

export function href(to: string): string {
  return BASE + (to === '/' ? '/' : to);
}

export function navigate(to: string): void {
  const [p, hash] = to.split('#') as [string, string | undefined];
  if (p !== path.value) {
    history.pushState(null, '', href(p) + (hash ? `#${hash}` : ''));
    path.value = p;
    window.scrollTo(0, 0);
  } else if (hash) {
    history.replaceState(null, '', `#${hash}`);
    document.getElementById(decodeURIComponent(hash))?.scrollIntoView({ block: 'start' });
  }
}

/** `<SiteLink to="/features">` — 왼쪽 클릭만 라우터로(새 탭 열기 등은 브라우저 그대로). */
export const SiteLink = defineComponent({
  name: 'SiteLink',
  props: { to: { type: String as PropType<string>, required: true } },
  setup(props, { slots, attrs }) {
    return () =>
      h(
        'a',
        {
          ...attrs,
          href: href(props.to),
          'aria-current': props.to === path.value ? 'page' : undefined,
          onClick: (e: MouseEvent) => {
            if (
              e.defaultPrevented ||
              e.button !== 0 ||
              e.metaKey ||
              e.ctrlKey ||
              e.shiftKey ||
              e.altKey
            )
              return;
            e.preventDefault();
            navigate(props.to);
          },
        },
        slots['default']?.(),
      );
  },
});
