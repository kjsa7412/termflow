/**
 * 「직접 해 보기」 — 논리명 하나를 표준 사전으로 풀어 보는 **축약판**(가상 소사전 · 브라우저 안 계산, 서버 없음).
 * 제품 엔진(프로젝트 사전 전체 · 유사 도메인 검색 · 코드구분 후보 · 캐시)의 판정 다섯 갈래만 흉내 낸다:
 *   표준(도메인 정확 일치) → 코드(…코드 + 코드구분) → 비슷한 후보 → 조합(용어 + 접미어 분류) → 미등록.
 */
export const TERMS: Record<string, string> = {
  교육: 'EDU',
  과정: 'CRS',
  신청: 'REQ',
  번호: 'NO',
  일자: 'DT',
  일시: 'DTS',
  명: 'NM',
  코드: 'CD',
  구분: 'TP',
  상태: 'STAT',
  여부: 'YN',
  사용: 'USE',
  사원: 'EMP',
  승인: 'APV',
  평가: 'EVL',
  점수: 'SCORE',
  시작: 'START',
  종료: 'END',
  시간: 'TM',
  자산: 'ASST',
  대여: 'RENT',
  반납: 'RTRN',
  장비: 'EQMT',
  금액: 'AMT',
  순서: 'ORD',
  사유: 'RESN',
  반려: 'RJCT',
  취소: 'CNCL',
  부서: 'DEPT',
  담당자: 'MNGR',
  장소: 'PLC',
  예정: 'EXPT',
  설문: 'SRVY',
  응답: 'RPNS',
  내용: 'DESC',
  제목: 'TITLE',
  일: 'DD',
  수: 'CNT',
  인원: 'TNOP',
  구매: 'PRCH',
};

/** 도메인분류(접미어 → 타입). 마지막 조각이 여기 있어야 조합 타입이 정해진다. */
export const CLASSES: Record<string, string> = {
  번호: 'VARCHAR(20)',
  일자: 'VARCHAR(8)',
  일시: 'TIMESTAMP(0)',
  명: 'VARCHAR(100)',
  코드: 'VARCHAR(10)',
  여부: 'VARCHAR(1)',
  점수: 'NUMERIC(5,2)',
  금액: 'NUMERIC(15)',
  순서: 'SMALLINT',
  사유: 'VARCHAR(200)',
  내용: 'VARCHAR(4000)',
  제목: 'VARCHAR(200)',
  수: 'INT',
  시간: 'NUMERIC(5,1)',
  인원: 'INT',
};

/** 표준 도메인(정확 일치). */
export const DOMAINS = [
  '교육과정번호',
  '교육과정명',
  '사원번호',
  '신청일자',
  '승인일자',
  '사용여부',
  '부서코드',
  '평가점수',
  '대여시작일자',
  '반납예정일자',
  '반납일자',
  '교육시작일자',
  '교육종료일자',
  '장비번호',
  '자산번호',
];

/** 코드구분(…코드 → 업무구분/코드구분 + 코드값). */
export const CODE_CLASSES: Record<string, { cls: string; codes: string[] }> = {
  교육구분코드: { cls: 'ED/010 교육구분', codes: ['01 집합', '02 온라인', '03 혼합'] },
  신청상태코드: { cls: 'ED/020 신청상태', codes: ['01 신청', '02 승인', '03 반려', '04 취소'] },
  자산상태코드: { cls: 'AS/010 자산상태', codes: ['01 보유', '02 대여중', '03 수리', '04 폐기'] },
};

export type Verdict = 'exact' | 'code' | 'similar' | 'composed' | 'unregistered' | 'empty';
export interface Piece {
  kor: string;
  physical: string | null;
}
export interface TryResult {
  verdict: Verdict;
  input: string;
  pieces: Piece[];
  physical: string | null;
  type: string | null;
  candidates: { logical: string; physical: string; type: string }[];
  code: { cls: string; codes: string[] } | null;
}

/** 왼쪽부터 가장 긴 용어로 자른다. 사전에 없는 글자는 이어 붙여 미등록 조각 하나로. */
export function segment(text: string): Piece[] {
  const keys = Object.keys(TERMS).sort((a, b) => b.length - a.length);
  const out: Piece[] = [];
  let i = 0;
  let unknown = '';
  while (i < text.length) {
    const k = keys.find((t) => text.startsWith(t, i));
    if (k) {
      if (unknown) out.push({ kor: unknown, physical: null });
      unknown = '';
      out.push({ kor: k, physical: TERMS[k]! });
      i += k.length;
    } else {
      unknown += text[i];
      i += 1;
    }
  }
  if (unknown) out.push({ kor: unknown, physical: null });
  return out;
}

function compose(pieces: Piece[]): { physical: string; type: string | null } {
  const last = pieces[pieces.length - 1];
  return {
    physical: pieces.map((p) => p.physical ?? '?').join('_'),
    type: last && last.physical ? (CLASSES[last.kor] ?? null) : null,
  };
}

export function resolve(raw: string): TryResult {
  const input = raw.replace(/\s+/g, '');
  const base: TryResult = {
    verdict: 'empty',
    input,
    pieces: [],
    physical: null,
    type: null,
    candidates: [],
    code: null,
  };
  if (!input) return base;
  const pieces = segment(input);
  const c = compose(pieces);
  const known = pieces.every((p) => p.physical);
  if (DOMAINS.includes(input)) return { ...base, verdict: 'exact', pieces, ...c };
  const code = CODE_CLASSES[input];
  if (code && known) return { ...base, verdict: 'code', pieces, ...c, code };
  if (!known) return { ...base, verdict: 'unregistered', pieces, ...c };
  // 접미어 분류가 없으면(예: '신청일') 앞부분이 같은 도메인을 후보로
  if (!c.type) {
    const candidates = DOMAINS.filter(
      (d) => d.startsWith(input) || input.startsWith(d.slice(0, -1)),
    )
      .slice(0, 5)
      .map((d) => ({ logical: d, ...compose(segment(d)) }))
      .filter((x): x is { logical: string; physical: string; type: string } => x.type !== null);
    return { ...base, verdict: 'similar', pieces, ...c, candidates };
  }
  return { ...base, verdict: 'composed', pieces, ...c };
}

export const EXAMPLES = ['교육과정번호', '교육신청일자', '신청일', '교육구분코드', '강의실번호'];
