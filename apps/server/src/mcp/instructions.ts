/**
 * 외부 연동 서버 안내문(initialize 응답 `instructions`)과 프롬프트(CR-18 C7·C12). 클라이언트가 안내문을 약 2천 자에서
 * 자르므로 테이블 설계 가이드(docs/04)의 핵심 원칙 P1~P8과 상세 절차 문서 위치만 둔다(T18.12).
 * 결과(물리명·타입·DDL)는 언제나 서버 규칙 엔진이 낸다.
 */
export const SERVER_INSTRUCTIONS = `TermFlow = 표준 용어·도메인 기반 테이블 설계·DDL 생성 서비스. 도구는 REST API와 1:1이고 토큰 주인의 권한(프로젝트 역할 VIEWER < EDITOR < ADMIN)을 따른다.

설계 규칙(테이블 설계 가이드 P1~P8, 반드시 지킨다)
P1 물리명·타입·길이는 표준 사전에서 나온다. 테이블명은 table_name_suggest, 컬럼은 columns_autocomplete 결과만 쓰고 손으로 짓거나 고치지 않는다(MANUAL 금지). 사전에 없으면 먼저 등록하고 다시 받는다.
P2 자동완성 처리 순위: exact → 코드성 컬럼은 codeCandidates로 CODE → similar 중 같은 뜻이면 논리명을 그 도메인 이름으로 바꿔 exact → 도메인 등록 대상(P3)이면 domain_create 후 exact → 그 외에만 composed. unregistered는 저장하지 않고 terms_check → term_request/term_create 후 다시 받는다.
P3 같은 뜻은 모든 테이블에서 같은 도메인. PK·FK·조인 키와 둘 이상 테이블에 나오는 컬럼은 composed로 두지 말고 도메인을 등록한다.
P4 '…코드'·구분·유형·상태·등급처럼 값이 정해진 컬럼은 코드구분에 연결(codeClsId, matchType CODE). 코드 마스터 테이블의 키만 예외(도메인).
P5 프로젝트 기본컬럼 세트(project_settings_get → default_column_set_get)를 모든 테이블 끝에 넣는다(defaultColId 유지, matchType DEFAULT, columnId null). table_create는 자동으로 넣지 않는다. 빼려면 사용자 지시와 테이블 설명의 '기본컬럼 제외: 사유'가 있어야 한다.
P6 접미어 기본 타입과 다른 타입이 필요하면 컬럼에서 고치지 말고 그 타입의 도메인을 만든다.
P7 table_validate 오류 0·경고 0에서 저장한다. 경고를 남기면 사유를 테이블 설명에 적고 보고한다.
P8 용어·도메인·코드 등록은 프로젝트 전체에 영향 — 등록안을 표로 보여 주고 확인받은 뒤 등록한다. 삭제·확정·승인·반려·관리 작업도 사용자 확인 후에만.

기타
- defaultVal: 문자열은 따옴표 없이(N), 숫자는 그대로, 함수는 CURRENT_TIMESTAMP·CURRENT_DATE만.
- 오류는 ProblemDetail(code·detail·errors[]의 rowIndex·field). 409 E_VERSION_CONFLICT면 table_get으로 다시 읽어 합친다. 수정은 table_get → 전체 columns(columnId 유지)+version으로 table_save.
- 단계별 절차: 프롬프트 design_table, 또는 TermFlow 저장소 docs/skills/termflow-table-design/SKILL.md(설계 절차 스킬). 판단 기준 전문: docs/04_테이블_설계_가이드.md.`;

export interface PromptArg {
  name: string;
  description: string;
  required: boolean;
}

export const TABLE_DESIGN_PROMPT = {
  name: 'design_table',
  title: 'TermFlow 규약으로 테이블 설계',
  description:
    '요구사항을 받아 표준 용어·도메인에 맞는 테이블을 설계·검증·저장하고 DDL을 보여 준다.',
  // 클라이언트가 인자를 공백으로 나눠 넘기는 경우가 있다(`/termflow:design_table QATEST RP …`) —
  // 한 단어 값(키·코드)을 앞에 두고, 문장인 요구사항은 선택으로 받아 없거나 잘렸으면 먼저 묻게 한다.
  arguments: [
    { name: 'projectKey', description: '프로젝트 키(예 QATEST)', required: true },
    { name: 'bizArea', description: '업무구분 코드(예 RP, 생략하면 고른다)', required: false },
    {
      name: 'requirement',
      description: '만들 테이블 설명(생략하면 먼저 묻는다)',
      required: false,
    },
  ] satisfies PromptArg[],
};

export function tableDesignPromptText(args: Record<string, string | undefined>): string {
  const req = args['requirement']?.trim();
  return `TermFlow 프로젝트 ${args['projectKey'] ?? '(키 미지정)'}에서 테이블을 설계하라.
${args['bizArea'] ? `업무구분: ${args['bizArea']}\n` : ''}
요구사항: ${req ? req : '(아직 없음)'}

요구사항이 없거나 한두 단어로 잘려 보이면 도구를 부르기 전에 사용자에게 먼저 묻는다 — 테이블의 목적(무엇을 기록하나), 한 행의 의미, 키, 다른 테이블과의 관계.
서버 안내문의 설계 규칙 P1~P8을 따른다. 진행 방법:
1. 준비: whoami(역할 — 편집자면 도메인·코드구분 등록은 프로젝트 관리자에게 요청해야 함을 알린다), project_settings_get(기본 방언·기본컬럼 세트), biz_areas_list, default_column_set_get, domain_classes_list.
2. 테이블 논리명과 컬럼 논리명 목록(등록 용어 + 도메인분류 접미어로 끝나는 이름)을 먼저 보여 준다. 여러 테이블이면 공통 키·참조·시각 컬럼을 먼저 뽑아 도메인으로 등록한다.
3. table_name_suggest·columns_autocomplete 결과를 P2 순위로 처리한다. composed로 둔 컬럼은 "한 테이블 전용·기본 타입·키 아님" 근거를 남긴다. 필요한 용어·도메인·코드구분은 한 번에 등록안 표로 보여 주고 확인받은 뒤 등록하고 다시 자동완성한다.
4. PK·NULL 허용을 정하고 기본컬럼 세트를 끝에 넣어 table_validate 오류 0·경고 0을 만든 뒤 table_create로 저장한다.
5. 저장한 테이블의 DDL(table_ddl)과 완료 보고를 보여 준다 — 매칭 통계(EXACT·CODE·COMPOSED·DEFAULT, SIMILAR 0·MANUAL 0), COMPOSED 사유, 사전 변경 목록, 예외(기본컬럼 제외·남긴 경고와 사유), 검증 결과.`;
}
