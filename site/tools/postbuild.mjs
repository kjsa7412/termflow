#!/usr/bin/env node
// 소개 사이트 빌드 뒤처리(T12.7): vite 산출물(dist/) → 주소별 사본 · 404 · robots · sitemap → 누출 검사(걸리면 실패).
//
// 주소별 사본: /features → dist/features/index.html. 정적 호스팅(Vercel 등)이 SPA 폴백 없이도 각 주소에 그 페이지의
// <title>·description·canonical을 낸다(검색·링크 미리보기). 본문은 같은 SPA가 그린다.
// sitemap·canonical의 절대 주소: TERMFLOW_SITE_URL(예 https://termflow.example.com) > VERCEL_PROJECT_PRODUCTION_URL. 없으면 둘 다 생략.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLeaks } from './leaks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', 'dist');
const { ROUTES, NOT_FOUND } = await import(new URL('../src/routes.ts', import.meta.url).href);

const base = (process.env.TERMFLOW_SITE_BASE ?? '/').replace(/\/?$/, '/');
const host =
  process.env.TERMFLOW_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : '');
const origin = host.replace(/\/$/, '');
const abs = (p) => (origin ? `${origin}${base}${p === '/' ? '' : p.slice(1)}` : null);

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const shell = readFileSync(path.join(DIST, 'index.html'), 'utf8');

function page(meta, { canonical, noindex } = {}) {
  let html = shell
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(meta.title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/, `$1${esc(meta.description)}$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${esc(meta.title)}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${esc(meta.description)}$2`);
  const extra = [];
  if (canonical)
    extra.push(
      `<link rel="canonical" href="${canonical}" />`,
      `<meta property="og:url" content="${canonical}" />`,
    );
  if (noindex) extra.push('<meta name="robots" content="noindex" />');
  if (extra.length) html = html.replace('</head>', `    ${extra.join('\n    ')}\n  </head>`);
  return html;
}

for (const r of ROUTES) {
  const out =
    r.path === '/' ? path.join(DIST, 'index.html') : path.join(DIST, r.path.slice(1), 'index.html');
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, page(r, { canonical: abs(r.path) }));
}
writeFileSync(path.join(DIST, '404.html'), page(NOT_FOUND, { noindex: true }));
// abs('/')는 `<origin><base>`(끝이 /)
writeFileSync(
  path.join(DIST, 'robots.txt'),
  `User-agent: *\nAllow: /\n${origin ? `Sitemap: ${abs('/')}sitemap.xml\n` : ''}`,
);
if (origin) {
  const urls = ROUTES.map((r) => `  <url><loc>${abs(r.path)}</loc></url>`).join('\n');
  writeFileSync(
    path.join(DIST, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
  );
}
console.log(
  `[site] 주소별 사본 ${ROUTES.length} · 404 · robots${origin ? ' · sitemap' : ' (TERMFLOW_SITE_URL 없음 — sitemap·canonical 생략)'}`,
);

const leaks = checkLeaks(DIST);
if (leaks.length) {
  console.error(
    `[site] 누출 검사 실패 — 사외 공개 사이트에 실으면 안 되는 이름 ${leaks.length}건:`,
  );
  for (const l of leaks) console.error(`  ${l.file}: "${l.term}" … ${l.context}`);
  process.exit(1);
}
console.log('[site] 누출 검사 OK');
