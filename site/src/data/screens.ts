/**
 * 화면 그림 — 설명서와 같은 `docs/img/screens/*.png`(e2e `site-shots`가 데모 인스턴스에서 찍는다, T12.6).
 * 데이터는 가상 데모 프로젝트 EDU(교육 운영 관리)다. 그림을 다시 찍으면 설명만 여기서 맞춘다.
 */
const files = import.meta.glob<string>('../../../docs/img/screens/*.png', {
  eager: true,
  import: 'default',
});

export function shotUrl(id: string): string {
  const hit = Object.entries(files).find(([k]) => k.endsWith(`/${id}.png`));
  if (!hit) throw new Error(`화면 그림이 없습니다: ${id}`);
  return hit[1];
}

export interface Screen {
  id: string;
  group: '시작' | '표준 사전' | '테이블 설계' | 'DDL' | '관리';
  title: string;
  desc: string;
}

export const SCREENS: Screen[] = [
  {
    id: '01-login',
    group: '시작',
    title: '로그인',
    desc: '계정은 관리자가 발급한다. 아래쪽 링크로 로그인 전에도 사용자 가이드를 연다.',
  },
  {
    id: '02-projects',
    group: '시작',
    title: '프로젝트 목록',
    desc: '내가 속한 프로젝트 카드 — 키·이름·내 역할·업무구분·테이블 수.',
  },
  {
    id: '03-project-home',
    group: '시작',
    title: '프로젝트 홈',
    desc: '테이블·검토대기 용어·검토필요 도메인 건수, 업무구분별 테이블, 최근 변경 이력.',
  },
  {
    id: '04-terms',
    group: '표준 사전',
    title: '용어',
    desc: '한글 용어 ↔ 물리약어. 맨 위 줄에서 바로 등록, 같은 약어를 쓰는 용어는 동의어 참조로 묶인다.',
  },
  {
    id: '05-domains',
    group: '표준 사전',
    title: '도메인',
    desc: '조각(용어)과 접미어(도메인분류)로 물리명·타입을 계산한다. 정할 수 없던 행은 검토필요.',
  },
  {
    id: '06-codes',
    group: '표준 사전',
    title: '코드',
    desc: '업무구분 › 코드구분 › 코드. 코드성 컬럼과 DDL 코멘트에 쓰인다.',
  },
  {
    id: '12-approvals',
    group: '표준 사전',
    title: '승인 큐',
    desc: '편집자가 편집기에서 등록한 검토대기 용어 — 승인·약어 고쳐 승인·반려.',
  },
  {
    id: '07-tables',
    group: '테이블 설계',
    title: '테이블 목록',
    desc: '업무구분별 테이블, 상태(DRAFT·FINAL)·컬럼 수·최종 수정.',
  },
  {
    id: '08-editor',
    group: '테이블 설계',
    title: '테이블 편집기',
    desc: '논리명을 쓰고 Enter — 물리명·타입·코멘트가 표준으로 채워진다. 오른쪽은 저장 전에도 보이는 DDL.',
  },
  {
    id: '09-autocomplete',
    group: '테이블 설계',
    title: '비슷한 후보',
    desc: "정확히 맞는 도메인이 없으면 비슷한 도메인과 용어 조합을 고른다('신청일' → 신청일자).",
  },
  {
    id: '10-inline-register',
    group: '테이블 설계',
    title: '인라인 용어 등록',
    desc: "사전에 없는 조각('강의')은 그 자리에서 물리약어를 넣어 검토대기로 등록하고 바로 쓴다.",
  },
  {
    id: '11-ddl-export',
    group: 'DDL',
    title: 'DDL 내보내기',
    desc: '여러 테이블을 한 번에 — 단일 .sql · 테이블별 .zip · 정보 추출 .tsv, 옵션별 미리보기.',
  },
  {
    id: '13-project-new',
    group: '관리',
    title: '새 프로젝트',
    desc: '기본 정보 · 표준 가져오기(템플릿/다른 프로젝트/비움, 건수 미리보기) · 멤버, 한 페이지 3단계.',
  },
  {
    id: '14-project-settings',
    group: '관리',
    title: '프로젝트 설정',
    desc: '기본 정보·멤버(역할)·기본 방언·기본컬럼 세트.',
  },
  {
    id: '16-biz-areas',
    group: '관리',
    title: '업무구분',
    desc: '테이블 물리명 접두어와 코드 분류의 기준. 테이블이 생기면 코드·접두어가 잠긴다.',
  },
  {
    id: '15-users',
    group: '관리',
    title: '사용자',
    desc: '계정 발급(초기 비밀번호 한 번 표시), 잠금 해제·초기화·비활성화.',
  },
  {
    id: '17-templates',
    group: '관리',
    title: '템플릿',
    desc: '새 프로젝트의 표준 원본. 잘 정리된 프로젝트의 표준을 새 템플릿으로 게시한다.',
  },
  {
    id: '18-manual',
    group: '시작',
    title: '설명서',
    desc: '사용자 가이드를 제품 안에서 — 상단 바 ? 단추, 로그인 전에도 열린다.',
  },
];
