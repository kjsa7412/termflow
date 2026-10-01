import { readFileSync } from 'node:fs';
import path from 'node:path';
import MarkdownIt from 'markdown-it';
import type { Plugin } from 'vite';

/**
 * 제품 내 설명서(T12.5, CR-12 C4): `docs/*.md` 원문을 **빌드 때** HTML로 바꿔 번들에 싣는다(서버 API·런타임 Markdown 없음).
 * 화면(`pages/ManualPage.vue`)은 `virtual:termflow-manual`을 지연 import한다.
 *
 * 변환 규칙
 *  - 제목 앵커: GitHub 규칙(소문자, 글자·숫자·`_`·`-`·공백만 남기고 공백 → `-`, 겹치면 `-1`…) — 문서 안 `#절` 링크가 그대로 간다.
 *  - 목차: h2·h3. 원문 HTML은 그대로 내지 않는다(`html: false`, 이스케이프).
 *  - 링크: 다른 책(`설치_운영_가이드.md#…`) → `/manual/<id>#…`(라우터 이동), 외부 → 새 창,
 *    그 밖의 저장소 파일(`CR-11_….md` 등) → 링크 없는 글자(제품 안에서 열 수 없다 — 깨진 링크를 두지 않는다).
 *  - 인라인 코드가 정적 화면 경로(`/admin/users`, `/projects/new`, `/me`)면 그 화면 링크.
 *  - 그림: 문서 기준 상대 경로를 Vite 자산 import로 바꾼다(빌드 시 해시 파일, `docs/img/screens/`).
 */
export interface ManualBookDef {
  id: string;
  /** 저장소 루트 기준 원문 경로. */
  file: string;
  /** all = 로그인 전에도 열람, sysadmin = 시스템 관리자만(CR-12 C4). */
  audience: 'all' | 'sysadmin';
  icon: string;
  /** 책 목록에 쓰는 짧은 설명. */
  desc: string;
}

export const MANUAL_BOOKS: readonly ManualBookDef[] = [
  {
    id: '사용자_가이드',
    file: 'docs/사용자_가이드.md',
    audience: 'all',
    icon: 'book',
    desc: '역할별 사용법 — 프로젝트·표준 사전·테이블 설계·DDL',
  },
  {
    id: '설치_운영_가이드',
    file: 'docs/설치_운영_가이드.md',
    audience: 'sysadmin',
    icon: 'settings',
    desc: '설치(Windows·Linux)·승계·백업·복구·업그레이드',
  },
];

export interface TocItem {
  level: 2 | 3;
  slug: string;
  text: string;
}
export interface RenderedManual {
  title: string;
  html: string;
  toc: TocItem[];
  /** html 안 `__TFIMG_n__` 자리 → 문서 기준으로 푼 그림 파일 절대 경로. */
  images: string[];
}

/** GitHub 제목 앵커 규칙(github-slugger와 같은 문자 집합). */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');
}

/** 정적 화면 경로(파라미터 없는 것만) — 인라인 코드를 링크로 바꾼다. */
const APP_PATH = /^\/(?:projects(?:\/new)?|me|admin\/(?:users|projects|templates))$/;

interface Env {
  bookIds: ReadonlySet<string>;
  baseDir: string;
  images: string[];
  /** link_open에서 링크를 글자로 바꾼 것인지(link_close 짝 맞춤). */
  linkStack: boolean[];
  slugs: Map<string, number>;
  toc: TocItem[];
  title: string;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function createRenderer(): MarkdownIt {
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
  const r = md.renderer.rules;

  r['heading_open'] = (tokens, idx, _o, env: Env) => {
    const tok = tokens[idx]!;
    const inline = tokens[idx + 1];
    const text = (inline?.children ?? [])
      .filter((c) => c.type === 'text' || c.type === 'code_inline')
      .map((c) => c.content)
      .join('');
    const level = Number(tok.tag.slice(1));
    if (level === 1) {
      if (!env.title) env.title = text;
      return `<${tok.tag}>`;
    }
    const base = slugify(text);
    const n = env.slugs.get(base) ?? 0;
    env.slugs.set(base, n + 1);
    const slug = n === 0 ? base : `${base}-${n}`;
    if (level === 2 || level === 3) env.toc.push({ level, slug, text });
    return `<${tok.tag} id="${esc(slug)}"><a class="doc-anchor" href="#${esc(encodeURIComponent(slug))}" aria-hidden="true" tabindex="-1">#</a>`;
  };

  // markdown-it이 href를 이미 퍼센트 인코딩했다(한글 앵커 `#가` → `#%EA%B0%80`) — 그대로 내면 브라우저가 푼다
  r['link_open'] = (tokens, idx, _o, env: Env) => {
    const href = tokens[idx]!.attrGet('href') ?? '';
    if (href.startsWith('#')) {
      env.linkStack.push(false);
      return `<a href="${esc(href)}">`;
    }
    if (/^https?:\/\//.test(href)) {
      env.linkStack.push(false);
      return `<a href="${esc(href)}" target="_blank" rel="noopener">`;
    }
    const m = /^(?:\.\/)?([^/#?:]+)\.md(#.*)?$/.exec(href);
    if (m) {
      let id = m[1]!;
      try {
        id = decodeURIComponent(id);
      } catch {
        /* 그대로 */
      }
      if (env.bookIds.has(id)) {
        env.linkStack.push(false);
        return `<a href="/manual/${encodeURIComponent(id)}${esc(m[2] ?? '')}" data-route="1">`;
      }
    }
    env.linkStack.push(true);
    let shown = href;
    try {
      shown = decodeURIComponent(href);
    } catch {
      /* 그대로 */
    }
    return `<span class="doc-ref" title="저장소 파일: ${esc(shown)}">`;
  };
  r['link_close'] = (_t, _i, _o, env: Env) => (env.linkStack.pop() ? '</span>' : '</a>');

  r['image'] = (tokens, idx, _o, env: Env) => {
    const tok = tokens[idx]!;
    const src = tok.attrGet('src') ?? '';
    const alt = tok.children?.map((c) => c.content).join('') ?? tok.content;
    if (/^(?:https?:)?\/\//.test(src)) return '';
    let rel = src;
    try {
      rel = decodeURIComponent(src);
    } catch {
      /* 그대로 */
    }
    const n = env.images.push(path.resolve(env.baseDir, rel)) - 1;
    return `<img src="__TFIMG_${n}__" alt="${esc(alt)}" loading="lazy" decoding="async">`;
  };

  r['code_inline'] = (tokens, idx) => {
    const c = tokens[idx]!.content;
    const code = `<code>${esc(c)}</code>`;
    return APP_PATH.test(c)
      ? `<a href="${c}" data-route="1" class="doc-app-link">${code}</a>`
      : code;
  };

  r['fence'] = (tokens, idx) => {
    const tok = tokens[idx]!;
    const lang = tok.info.trim().split(/\s+/)[0] ?? '';
    return `<pre class="doc-pre"${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(tok.content)}</code></pre>\n`;
  };
  r['table_open'] = () => '<div class="doc-table"><table>\n';
  r['table_close'] = () => '</table></div>\n';
  return md;
}

const renderer = createRenderer();

/** Markdown 원문 → 설명서 HTML·목차. `baseDir`는 그림 상대 경로의 기준(원문 폴더). */
export function renderManual(
  source: string,
  opts: { bookIds: readonly string[]; baseDir: string },
): RenderedManual {
  const env: Env = {
    bookIds: new Set(opts.bookIds),
    baseDir: opts.baseDir,
    images: [],
    linkStack: [],
    slugs: new Map(),
    toc: [],
    title: '',
  };
  const html = renderer.render(source, env);
  return { title: env.title, html, toc: env.toc, images: env.images };
}

export const MANUAL_MODULE = 'virtual:termflow-manual';
const RESOLVED = '\0' + MANUAL_MODULE;

/** `virtual:termflow-manual` — `{ id, title, audience, icon, desc, toc, html }[]`. 원문이 바뀌면 화면을 다시 불러온다. */
export function manualPlugin(repoRoot: string): Plugin {
  const files = MANUAL_BOOKS.map((b) => path.resolve(repoRoot, b.file));
  return {
    name: 'termflow-manual',
    resolveId: (id) => (id === MANUAL_MODULE ? RESOLVED : null),
    load(id) {
      if (id !== RESOLVED) return null;
      const ids = MANUAL_BOOKS.map((b) => b.id);
      const imports: string[] = [];
      const books = MANUAL_BOOKS.map((b, i) => {
        const file = files[i]!;
        this.addWatchFile(file);
        const out = renderManual(readFileSync(file, 'utf8'), {
          bookIds: ids,
          baseDir: path.dirname(file),
        });
        let html = JSON.stringify(out.html);
        out.images.forEach((img, n) => {
          const v = `img_${i}_${n}`;
          imports.push(`import ${v} from ${JSON.stringify(img.replace(/\\/g, '/'))};`);
          html = html.replace(`__TFIMG_${n}__`, `" + ${v} + "`);
        });
        return `{ id: ${JSON.stringify(b.id)}, title: ${JSON.stringify(out.title || b.id)}, audience: ${JSON.stringify(b.audience)}, icon: ${JSON.stringify(b.icon)}, desc: ${JSON.stringify(b.desc)}, toc: ${JSON.stringify(out.toc)}, html: ${html} }`;
      });
      return `${imports.join('\n')}\nexport default [\n${books.join(',\n')}\n];\n`;
    },
    handleHotUpdate(ctx) {
      if (!files.includes(path.resolve(ctx.file))) return;
      const mod = ctx.server.moduleGraph.getModuleById(RESOLVED);
      if (mod) ctx.server.moduleGraph.invalidateModule(mod);
      ctx.server.ws.send({ type: 'full-reload' });
      return [];
    },
  };
}
