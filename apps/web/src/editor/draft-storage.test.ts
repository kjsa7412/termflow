import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DRAFT_MAX_ENTRIES,
  draftKey,
  listDrafts,
  loadDraft,
  removeDraft,
  saveDraft,
  sameContent,
  type EditorDraft,
} from './draft-storage.js';

// T8.13 localStorage 임시저장 규칙(§8.7): 키·상한 50건·512KB·7일·try/catch
const draft = (savedAt: string, extra = ''): EditorDraft => ({
  savedAt,
  baseVersion: 3,
  table: { bizAreaId: 6, tableNm: 'RP_A', tableLogicalNm: `가${extra}`, description: null },
  columns: [],
  cacheVersion: null,
});
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('임시저장(§8.7)', () => {
  it('키 형식: tf.draft.{projectKey}.{tableId | new-<uuid>}', () => {
    expect(draftKey('RMS', 17)).toBe('tf.draft.RMS.17');
    expect(draftKey('RMS', 'abc')).toBe('tf.draft.RMS.new-abc');
  });

  it('저장·읽기·삭제, 테이블당 1건(덮어쓰기), 같은 내용 판정', () => {
    const k = draftKey('RMS', 1);
    expect(saveDraft(k, draft(new Date().toISOString()))).toBe(true);
    expect(saveDraft(k, draft(new Date().toISOString(), '2'))).toBe(true);
    expect(listDrafts()).toHaveLength(1);
    expect(loadDraft(k)!.table.tableLogicalNm).toBe('가2');
    expect(sameContent(loadDraft(k)!, draft('x', '2'))).toBe(true);
    expect(sameContent(loadDraft(k)!, draft('x', '3'))).toBe(false);
    removeDraft(k);
    expect(loadDraft(k)).toBeNull();
  });

  it('7일 지난 항목은 읽을 때 지운다', () => {
    const k = draftKey('RMS', 2);
    const old = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    localStorage.setItem(k, JSON.stringify(draft(old)));
    expect(loadDraft(k)).toBeNull();
    expect(localStorage.getItem(k)).toBeNull();
  });

  it('전체 50건 상한: 오래된 것부터 삭제(방금 쓴 항목은 유지)', () => {
    const base = Date.now() - 3600_000;
    for (let i = 0; i < DRAFT_MAX_ENTRIES; i++) {
      localStorage.setItem(
        draftKey('RMS', i + 100),
        JSON.stringify(draft(new Date(base + i * 1000).toISOString())),
      );
    }
    expect(saveDraft(draftKey('RMS', 999), draft(new Date().toISOString()))).toBe(true);
    const keys = listDrafts().map((d) => d.key);
    expect(keys).toHaveLength(DRAFT_MAX_ENTRIES);
    expect(keys).not.toContain(draftKey('RMS', 100));
    expect(keys).toContain(draftKey('RMS', 999));
  });

  it('512KB 초과 항목은 저장하지 않는다', () => {
    const big = {
      ...draft(new Date().toISOString()),
      table: { ...draft('x').table, description: 'x'.repeat(600 * 1024) },
    };
    expect(saveDraft(draftKey('RMS', 3), big)).toBe(false);
    expect(localStorage.getItem(draftKey('RMS', 3))).toBeNull();
  });

  it('저장소 오류(용량 초과·차단)는 삼킨다 — 편집기는 계속 동작', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(saveDraft(draftKey('RMS', 4), draft(new Date().toISOString()))).toBe(false);
    expect(loadDraft(draftKey('RMS', 4))).toBeNull();
    expect(() => removeDraft(draftKey('RMS', 4))).not.toThrow();
  });
});
