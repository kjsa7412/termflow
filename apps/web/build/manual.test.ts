import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MANUAL_BOOKS, MANUAL_DOWNLOADS, renderManual, slugify } from './manual.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const opts = { bookIds: ['사용자_가이드', '설치_운영_가이드'], baseDir: '/repo/docs' };

describe('설명서 변환(T12.5)', () => {
  it('제목 앵커는 GitHub 규칙 — 한글·숫자 유지, 문장부호 제거, 공백은 -', () => {
    expect(slugify('2.1 로그인·비밀번호')).toBe('21-로그인비밀번호');
    expect(slugify('14. Linux 서버 설치')).toBe('14-linux-서버-설치');
    expect(slugify('`.env` 작성')).toBe('env-작성');
  });

  it('내려받기 원문(설계 절차 스킬)을 가리키는 상대 링크는 제품 안 내려받기 링크, 원문 파일이 있다(T18.14)', () => {
    const docs = path.join(ROOT, 'docs');
    const out = renderManual('[스킬](skills/termflow-table-design/SKILL.md) [CR](CR-18.md)', {
      ...opts,
      baseDir: docs,
      repoRoot: ROOT,
    });
    expect(out.html).toContain(
      '<a href="/downloads/termflow-table-design/SKILL.md" download="SKILL.md">스킬</a>',
    );
    expect(out.html).toContain('<span class="doc-ref"');
    for (const d of MANUAL_DOWNLOADS)
      expect(readFileSync(path.join(ROOT, d.file), 'utf8')).toMatch(/^---\r?\nname: /);
    // 사용자 가이드가 실제로 내려받기 링크를 건다
    const guide = renderManual(readFileSync(path.join(docs, '사용자_가이드.md'), 'utf8'), {
      ...opts,
      baseDir: docs,
      repoRoot: ROOT,
    });
    expect(guide.html).toContain('href="/downloads/termflow-table-design/SKILL.md"');
  });

  it('h1은 제목, h2·h3은 목차 — 같은 제목은 -1을 붙인다', () => {
    const out = renderManual('# 책\n\n## 가\n\n### 나\n\n## 가\n\n#### 깊음\n', opts);
    expect(out.title).toBe('책');
    expect(out.toc).toEqual([
      { level: 2, slug: '가', text: '가' },
      { level: 3, slug: '나', text: '나' },
      { level: 2, slug: '가-1', text: '가' },
    ]);
    expect(out.html).toContain('<h2 id="가-1">');
  });

  it('링크 — 다른 책은 /manual, 외부는 새 창, 그 밖 저장소 파일은 링크 없는 글자', () => {
    const out = renderManual(
      '[운영](설치_운영_가이드.md#4-승계) [밖](https://example.com) [CR](CR-11_단계11_릴리스.md) [절](#가)',
      opts,
    );
    const enc = encodeURIComponent;
    expect(out.html).toContain(
      `<a href="/manual/${enc('설치_운영_가이드')}#4-${enc('승계')}" data-route="1">운영</a>`,
    );
    expect(out.html).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener">밖</a>',
    );
    expect(out.html).toContain(
      '<span class="doc-ref" title="저장소 파일: CR-11_단계11_릴리스.md">CR</span>',
    );
    expect(out.html).toContain(`<a href="#${enc('가')}">절</a>`);
  });

  it('원문 HTML은 이스케이프하고, 정적 화면 경로 인라인 코드는 링크로', () => {
    const out = renderManual('<script>x</script> `/admin/users` `/projects/{키}/tables`', opts);
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain(
      '<a href="/admin/users" data-route="1" class="doc-app-link"><code>/admin/users</code></a>',
    );
    expect(out.html).toContain('<code>/projects/{키}/tables</code>');
  });

  it('그림은 원문 폴더 기준 경로로 모으고 자리표시로 바꾼다', () => {
    const out = renderManual('![편집기](img/screens/08-editor.png)', opts);
    expect(out.images).toEqual([path.resolve('/repo/docs', 'img/screens/08-editor.png')]);
    expect(out.html).toContain('<img src="__TFIMG_0__" alt="편집기" loading="lazy"');
  });

  it('표는 가로 스크롤 상자로, 코드 블록은 이스케이프', () => {
    const out = renderManual('| a | b |\n|---|---|\n| 1 | 2 |\n\n```bash\necho "<x>"\n```\n', opts);
    expect(out.html).toContain('<div class="doc-table"><table>');
    expect(out.html).toContain(
      '<pre class="doc-pre" data-lang="bash"><code>echo &quot;&lt;x&gt;&quot;',
    );
  });

  it('실제 원문 두 권: 제목이 있고, 문서 안 #절·책 사이 링크가 모두 실제 앵커를 가리킨다', () => {
    const rendered = MANUAL_BOOKS.map((b) => {
      const file = path.join(ROOT, b.file);
      return {
        id: b.id,
        out: renderManual(readFileSync(file, 'utf8'), {
          bookIds: MANUAL_BOOKS.map((x) => x.id),
          baseDir: path.dirname(file),
          repoRoot: ROOT,
        }),
      };
    });
    const anchors = new Map(rendered.map((r) => [r.id, new Set(r.out.toc.map((t) => t.slug))]));
    for (const { id, out } of rendered) {
      expect(out.title, id).toMatch(/^TermFlow /);
      for (const m of out.html.matchAll(/href="(\/manual\/([^"#]+))?#([^"]+)"/g)) {
        const book = m[2] ? decodeURIComponent(m[2]) : id;
        const slug = decodeURIComponent(m[3]!);
        // 제목 앵커 자기 자신(#절 아이콘)은 toc에 없는 h4일 수 있다 — h2·h3 대상만 검사한다
        if (!anchors.get(book)?.has(slug)) {
          const all = [...out.html.matchAll(/ id="([^"]+)"/g)].map((x) => x[1]);
          expect(book === id && all.includes(slug), `${id}: ${m[0]}`).toBe(true);
        }
      }
    }
  });
});
