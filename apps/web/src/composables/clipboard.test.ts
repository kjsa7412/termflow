import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard.js';

// CR-15 C1: HTTP(비보안 컨텍스트)에는 navigator.clipboard가 없다 → textarea + execCommand('copy')로 복사
describe('copyText', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Clipboard API가 있으면 그것으로 복사한다', async () => {
    const writes: string[] = [];
    vi.stubGlobal('navigator', {
      clipboard: { writeText: (t: string) => (writes.push(t), Promise.resolve()) },
    });
    expect(await copyText('CREATE TABLE A ();')).toBe(true);
    expect(writes).toEqual(['CREATE TABLE A ();']);
  });

  it('Clipboard API가 없으면(HTTP) 숨긴 textarea를 선택해 execCommand로 복사하고 지운다', async () => {
    vi.stubGlobal('navigator', {});
    let copied = '';
    const exec = vi.fn((cmd: string) => {
      const ta = document.activeElement as HTMLTextAreaElement;
      copied = cmd === 'copy' ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : '';
      return true;
    });
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    expect(await copyText('SELECT 1;')).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
    expect(copied).toBe('SELECT 1;');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('Clipboard API가 거부되면 execCommand로 다시 시도하고, 그것도 안 되면 false', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: () => Promise.reject(new Error('NotAllowedError')) },
    });
    const exec = vi.fn(() => false);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    expect(await copyText('x')).toBe(false);
    expect(exec).toHaveBeenCalledWith('copy');
  });
});
