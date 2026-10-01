// 소개 사이트 누출 검사(T12.7, CR-12 C3): 사외 공개 산출물(dist/)에 사내 흔적(이관 프로젝트·원본 시스템·회사·내부 주소)이
// 들어가면 빌드를 실패시킨다. 이름 목록은 leak-names.txt(한 줄에 하나, # 주석). 영문·숫자 이름은 대소문자 구분 + 단어 경계로
// 찾는다(예 RMS가 forms·terms에 걸리지 않게). 그림(PNG)은 글자를 읽을 수 없으니 찍을 때 가상 데이터만 쓴다(e2e site-shots).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEXT = /\.(html|js|mjs|css|txt|xml|svg|json|map)$/i;

export function leakTerms() {
  return readFileSync(path.join(HERE, 'leak-names.txt'), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function pattern(term) {
  const e = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return /^[A-Za-z0-9_.-]+$/.test(term)
    ? new RegExp(`(?<![A-Za-z0-9_])${e}(?![A-Za-z0-9_])`, 'g')
    : new RegExp(e, 'g');
}

function* files(dir) {
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (TEXT.test(n)) yield p;
  }
}

/** dist 안 글자 파일에서 목록의 이름을 찾는다 → [{ file, term, context }]. */
export function checkLeaks(dist, terms = leakTerms()) {
  const out = [];
  const pats = terms.map((t) => [t, pattern(t)]);
  for (const f of files(dist)) {
    const text = readFileSync(f, 'utf8');
    for (const [term, re] of pats) {
      re.lastIndex = 0;
      const m = re.exec(text);
      if (m)
        out.push({
          file: path.relative(dist, f),
          term,
          context: text
            .slice(Math.max(0, m.index - 30), m.index + term.length + 30)
            .replace(/\s+/g, ' '),
        });
    }
  }
  return out;
}
