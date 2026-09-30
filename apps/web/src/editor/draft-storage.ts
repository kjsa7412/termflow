import type { ColumnInput } from '@termflow/shared';

/**
 * 편집기 localStorage 임시저장(설계서 §8.7·RK6, T8.13).
 *  - 키 `tf.draft.{projectKey}.{tableId 또는 new-<uuid>}`, 내용 `{savedAt, baseVersion, table, columns, cacheVersion}`
 *  - 테이블당 1건(같은 키 덮어쓰기), 전체 50건(오래된 것부터 삭제), 항목 512KB, 보존 7일
 *  - 모든 접근은 try/catch(사생활 모드·용량 초과·차단된 저장소에서도 편집기는 동작해야 한다)
 * 범위: 브라우저·사용자 프로필 단위(다른 PC로 이어지지 않음).
 */
export const DRAFT_PREFIX = 'tf.draft.';
export const DRAFT_MAX_ENTRIES = 50;
export const DRAFT_MAX_BYTES = 512 * 1024;
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface EditorDraft {
  /** ISO 시각(브라우저 로컬). */
  savedAt: string;
  /** 편집을 시작한 서버 version(신규는 null). 서버 version보다 작으면 "그 사이 다른 저장". */
  baseVersion: number | null;
  table: {
    bizAreaId: number | null;
    tableNm: string;
    tableLogicalNm: string;
    description: string | null;
  };
  /** 저장 본문과 같은 순서(일반 행 → 포함된 기본컬럼). */
  columns: ColumnInput[];
  /** 마지막 자동완성 응답의 캐시 버전(T9.7) — 자동완성을 쓰지 않았으면 null. */
  cacheVersion: number | null;
}

export function draftKey(projectKey: string, id: number | string): string {
  return `${DRAFT_PREFIX}${projectKey}.${typeof id === 'number' ? id : `new-${id}`}`;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function parse(raw: string | null): EditorDraft | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as EditorDraft;
    return d && typeof d.savedAt === 'string' && Array.isArray(d.columns) ? d : null;
  } catch {
    return null;
  }
}

/** 임시저장 목록(키·시각), 오래된 순. */
export function listDrafts(): { key: string; savedAt: number }[] {
  const s = storage();
  if (!s) return [];
  const out: { key: string; savedAt: number }[] = [];
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (!k || !k.startsWith(DRAFT_PREFIX)) continue;
      const d = parse(s.getItem(k));
      out.push({ key: k, savedAt: d ? Date.parse(d.savedAt) || 0 : 0 });
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => a.savedAt - b.savedAt);
}

/** 7일 지난 항목·깨진 항목 삭제 + 50건 초과분(오래된 것부터) 삭제. `keep`은 지우지 않는다. */
export function pruneDrafts(now = Date.now(), keep?: string): void {
  const s = storage();
  if (!s) return;
  try {
    const all = listDrafts();
    const alive = all.filter((d) => {
      const dead = d.savedAt === 0 || now - d.savedAt > DRAFT_TTL_MS;
      if (dead && d.key !== keep) s.removeItem(d.key);
      return !dead || d.key === keep;
    });
    let over = alive.length - DRAFT_MAX_ENTRIES;
    for (const d of alive) {
      if (over <= 0) break;
      if (d.key === keep) continue;
      s.removeItem(d.key);
      over--;
    }
  } catch {
    /* 저장소 접근 실패: 무시 */
  }
}

/** 저장(512KB 초과·저장소 오류면 false). 쓴 뒤 상한 정리. */
export function saveDraft(key: string, draft: EditorDraft): boolean {
  const s = storage();
  if (!s) return false;
  try {
    const text = JSON.stringify(draft);
    if (new Blob([text]).size > DRAFT_MAX_BYTES) return false;
    s.setItem(key, text);
    pruneDrafts(Date.now(), key);
    return true;
  } catch {
    return false;
  }
}

/** 읽기(7일 지났으면 지우고 null). */
export function loadDraft(key: string, now = Date.now()): EditorDraft | null {
  const s = storage();
  if (!s) return null;
  try {
    const d = parse(s.getItem(key));
    if (!d) return null;
    if (now - (Date.parse(d.savedAt) || 0) > DRAFT_TTL_MS) {
      s.removeItem(key);
      return null;
    }
    return d;
  } catch {
    return null;
  }
}

export function removeDraft(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    /* 무시 */
  }
}

/** 두 본문이 같은지(임시저장본이 서버 본과 다를 때만 복원 배너, §8.7). */
export function sameContent(
  a: Pick<EditorDraft, 'table' | 'columns'>,
  b: Pick<EditorDraft, 'table' | 'columns'>,
): boolean {
  return (
    JSON.stringify({ t: a.table, c: a.columns }) === JSON.stringify({ t: b.table, c: b.columns })
  );
}
