/**
 * 외부 연동 서버 안내문(initialize 응답 `instructions`)과 프롬프트(CR-18 C7). 에이전트가 TermFlow 규약대로
 * 테이블을 설계하도록 작업 순서를 알려 준다. 결과(물리명·타입·DDL)는 언제나 서버 규칙 엔진이 낸다.
 */
export const SERVER_INSTRUCTIONS = `TermFlow = 표준 용어·도메인 기반 테이블 설계·DDL 생성 서비스. 이 서버의 도구는 TermFlow REST API와 1:1이고, 토큰 주인의 권한(프로젝트 역할 VIEWER < EDITOR < ADMIN, 시스템 관리자)을 그대로 따른다.

원칙
- 물리명·타입·길이를 직접 지어내지 않는다. 테이블명은 table_name_suggest, 컬럼은 columns_autocomplete 결과를 쓴다. 규칙 밖 이름이 필요하면 먼저 용어·도메인을 등록해 규칙 안으로 넣는다.
- 표준 사전(용어·도메인·코드)을 바꾸면 그 프로젝트 전체에 영향이 있다. 새 용어 물리약어는 standards_search로 비슷한 기존 용어 약어 관례를 확인하고 정한다.
- 삭제·확정(FINAL)·승인·반려·프로젝트/사용자 관리처럼 되돌리기 어려운 작업은 사용자 확인 후에만 한다.
- 오류 응답은 ProblemDetail(JSON: code·detail·errors[]). 422 errors[]의 rowIndex·field를 보고 고쳐 다시 부른다. 409 E_VERSION_CONFLICT면 table_get으로 최신본을 다시 읽어 합친다.

테이블 설계 순서
1. whoami → 프로젝트 키·역할 확인. project_settings_get(기본 방언·기본컬럼 세트), biz_areas_list(업무구분 bizAreaId·접두어).
2. 테이블명: table_name_suggest {logicalNm, bizAreaId} → tableNm. complete=false면 segments의 matched=false 조각이 미등록 용어.
3. 컬럼: columns_autocomplete {logicalNms[], bizAreaId} → items[i].type
   - exact: applied를 그대로 쓴다(matchType EXACT, domainId).
   - similar: candidates에서 의미가 맞는 도메인을 고른다(없으면 composed 후보).
   - composed: applied 사용(표준 도메인 아님 — 자주 쓰일 컬럼이면 도메인 등록을 사용자에게 제안).
   - unregistered: segments 중 matched=false 조각이 사전에 없다 → terms_check로 중복 확인 → term_request(편집자, 검토대기로 즉시 사용 가능) 또는 term_create(프로젝트 관리자, 바로 승인) → 다시 columns_autocomplete.
   - '…코드' 컬럼: codeCandidates에서 코드구분을 고르면 codeClsId와 matchType CODE.
4. 도메인 추가(프로젝트 관리자): domain_classes_list로 접미어 확인 → domain_calculate {nm1..nm7 조각} 미리보기 → domain_create.
5. 기본컬럼: default_column_set_get(프로젝트 기본 세트)의 columns를 컬럼 끝에 넣는다 — defaultColId 유지, matchType DEFAULT, columnId null.
6. table_validate로 오류·경고 확인 → table_create {table:{bizAreaId, tableNm, tableLogicalNm, description}, columns:[{logicalNm, physicalNm, isPk, dataType, dataLength, dataScale, isNullable, defaultVal, colComment, domainId, codeClsId, defaultColId, matchType}]}.
7. table_ddl {id, query:{dialect}}로 DDL 확인. 여러 테이블은 ddl_generate(output JSON 또는 SQL).
8. 수정: table_get → 바꾼 전체 columns(기존 행 columnId 유지) + version으로 table_save. FINAL 테이블은 table_status로 DRAFT로 돌린 뒤(프로젝트 관리자) 고친다.`;

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

요구사항이 없거나 한두 단어로 잘려 보이면 도구를 부르기 전에 사용자에게 먼저 묻는다 — 테이블의 목적(무엇을 기록하나), 컬럼으로 둘 항목, 한 행을 구분하는 키.
서버 안내문의 "테이블 설계 순서"를 따른다. 진행 방법:
1. 테이블 논리명과 컬럼 논리명 목록(한국어 표준 용어 조합)을 먼저 정리해 보여 준다.
2. table_name_suggest·columns_autocomplete로 물리명·타입을 받는다. 미등록 용어·필요한 도메인은 등록안을 표로 보여 주고 확인을 받은 뒤 등록한다.
3. PK·NULL 허용·기본컬럼을 정해 table_validate로 오류 0건을 만든 뒤 table_create로 저장한다.
4. 저장한 테이블의 DDL(table_ddl)과 설계 요약(컬럼·매칭 종류·경고)을 보여 준다.`;
}
