import { describe, expect, it } from 'vitest';
import { fetchServerState, toServerState } from './health.js';

describe('toServerState', () => {
  it('terminus 응답의 status를 그대로 쓴다', () => {
    expect(toServerState({ status: 'ok', info: {}, error: {}, details: {} })).toBe('ok');
  });

  it('형식이 다르면 error', () => {
    expect(toServerState({ status: 'weird' })).toBe('error');
    expect(toServerState(null)).toBe('error');
  });
});

describe('fetchServerState', () => {
  it('네트워크 실패는 unreachable', async () => {
    const failing = (() => Promise.reject(new Error('down'))) as unknown as typeof fetch;
    await expect(fetchServerState(failing)).resolves.toBe('unreachable');
  });
});
