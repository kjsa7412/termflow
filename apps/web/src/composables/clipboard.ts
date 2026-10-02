/**
 * 클립보드 복사(CR-15 C1). `navigator.clipboard`는 보안 컨텍스트(HTTPS·localhost)에서만 있다 — 사내 기본 접속
 * `http://PC이름:7340`에서는 없어서 복사가 늘 실패했다. 없거나 거부되면 숨긴 textarea + `execCommand('copy')`로
 * 한 번 더 시도한다(사용자 클릭 처리 안에서 부르면 HTTP에서도 동작). 둘 다 안 되면 false.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* 권한 거부 등 — 아래 방식으로 다시 시도 */
    }
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
  const prevFocus = document.activeElement as HTMLElement | null;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.setAttribute('aria-hidden', 'true');
  ta.style.cssText =
    'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.appendChild(ta);
  ta.focus({ preventScroll: true });
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok: boolean;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  prevFocus?.focus?.({ preventScroll: true });
  return ok;
}
