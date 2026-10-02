/**
 * 조사 맞춤(CR-15 C13): 메시지의 `을(를)`·`은(는)`·`이(가)`·`과(와)`·`(으)로` 자리를 앞 글자의 받침에 맞춰 하나로 고른다.
 * 앞 글자는 따옴표·괄호 닫힘을 건너뛰고 찾는다(`'연구'은(는)` → `'연구'는`). 한글은 받침, 숫자·영문은 읽는 소리
 * (1 일·L 엘 → ㄹ, 3 삼·M 엠·N 엔 → 받침, 2 이·A 에이·R(ORDER 오더) → 받침 없음)로 판단한다. 판단할 수 없으면 그대로 둔다.
 */
type Final = 'none' | 'rieul' | 'other';

const DIGIT: Record<string, Final> = {
  '0': 'other', // 영
  '1': 'rieul', // 일
  '2': 'none',
  '3': 'other', // 삼
  '4': 'none',
  '5': 'none',
  '6': 'other', // 육
  '7': 'rieul', // 칠
  '8': 'rieul', // 팔
  '9': 'none',
};
const SKIP = new Set(["'", '"', '‘', '’', '“', '”', ')', ']', '}', '>', '》', '」', '』', ' ']);

function finalOf(ch: string): Final | null {
  const code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) {
    const jong = (code - 0xac00) % 28;
    return jong === 0 ? 'none' : jong === 8 ? 'rieul' : 'other';
  }
  if (ch in DIGIT) return DIGIT[ch]!;
  const c = ch.toLowerCase();
  if (c === 'l') return 'rieul'; // 엘 — r은 영어 단어 끝소리(ORDER 오더)로 받침 없음
  if (c === 'm' || c === 'n') return 'other'; // 엠·엔
  if (c >= 'a' && c <= 'z') return 'none';
  return null;
}

const PATTERN =
  /(을\(를\)|를\(을\)|은\(는\)|는\(은\)|이\(가\)|가\(이\)|과\(와\)|와\(과\)|\(으\)로)/g;

function pick(token: string, f: Final): string {
  switch (token) {
    case '을(를)':
    case '를(을)':
      return f === 'none' ? '를' : '을';
    case '은(는)':
    case '는(은)':
      return f === 'none' ? '는' : '은';
    case '이(가)':
    case '가(이)':
      return f === 'none' ? '가' : '이';
    case '과(와)':
    case '와(과)':
      return f === 'none' ? '와' : '과';
    default: // (으)로 — 받침 없음·ㄹ 받침이면 '로'
      return f === 'other' ? '으로' : '로';
  }
}

/** 문장 안의 조사 자리를 모두 맞춘다. */
export function fillJosa(text: string): string {
  if (!text.includes('(')) return text;
  return text.replace(PATTERN, (token: string, _g: string, at: number) => {
    let i = at - 1;
    while (i >= 0 && SKIP.has(text[i]!)) i--;
    const f = i >= 0 ? finalOf(text[i]!) : null;
    return f === null ? token : pick(token, f);
  });
}
