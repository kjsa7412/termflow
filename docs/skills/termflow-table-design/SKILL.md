---
name: termflow-table-design
description: TermFlow(MCP 서버 termflow)로 테이블을 설계·수정·저장할 때 따르는 절차. 표준 용어·도메인·코드구분·기본컬럼 규칙(테이블 설계 가이드 P1~P8)을 지켜 table_create/table_save까지 진행하고 완료 보고를 낸다. TermFlow 프로젝트에 테이블을 만들거나 고치라는 요청, columns_autocomplete·table_create 같은 termflow 도구를 쓰는 작업이면 이 절차를 쓴다.
---

# TermFlow 테이블 설계 절차

판단 기준 전문은 TermFlow 저장소 `docs/04_테이블_설계_가이드.md`(이하 가이드)다. 이 문서는 그 기준을 **도구 호출 순서**로 옮긴 것이다. 여기 적힌 규칙은 선택이 아니라 지켜야 하는 규칙이다. 예외는 각 단계에 적힌 조건을 만족하고 사용자 확인을 받은 경우에만 쓴다.

서버도 위반 일부를 경고로 돌려준다 — `W_DEFAULT_COLS_MISSING`(기본컬럼 누락), `W_MATCH_MANUAL`·`W_MATCH_SIMILAR`, `W_CODE_CLS_NONE`(코드구분 없는 `…_CD`), `W_COMPOSED_KEY`·`W_COMPOSED_SHARED`(도메인 없는 키·공통 컬럼). 그러나 **경고 0건이 설계 품질을 보장하지 않는다**(가이드 §7). 아래 판단을 직접 한다.

## 0. 시작 전 — 읽기만 한다

| 도구 | 확인할 것 |
|---|---|
| `whoami` | 프로젝트 역할. **편집자**면 용어는 `term_request`(검토대기)만 되고 도메인·코드구분·도메인분류 등록은 프로젝트 관리자에게 요청해야 한다 — 시작할 때 사용자에게 알린다 |
| `project_settings_get` | 기본 방언, `includeDefaultCols`, `defaultColSetId` |
| `biz_areas_list` | 업무구분 `bizAreaId`·접두어 |
| `default_column_set_get` | 기본 세트 컬럼(이름·순서·`defaultColId`) |
| `domain_classes_list` | 접미어(ID·NM·CD·DT·DTS·TS…)와 기본 타입 |

요구사항이 모호하면 도구를 부르기 전에 묻는다: **테이블 목적, 한 행의 의미, 키, 다른 테이블과의 관계**.

## 1. 논리명 설계 — 보여 주고 확인받는다

1. 테이블마다 테이블 논리명과 컬럼 논리명 목록을 표로 만든다.
   - 컬럼 논리명 = 등록 용어 조합 + **도메인분류 접미어**로 끝난다(사이트ID, 수신시각, 설비구분코드).
   - 값의 성격으로 접미어를 고른다: 정수 일련값은 순번(SEQ), 계산 안 하는 번호는 번호(NO), 개수는 수(CNT), 값 집합이 정해진 것은 코드(CD)·구분·상태·등급 등. 같은 의미에 다른 접미어를 섞지 않는다.
2. **여러 테이블**을 설계하면 공통 컬럼을 먼저 뽑는다 — PK·FK·조인 키, 둘 이상 테이블에 나오는 컬럼, 반복되는 시각 컬럼. 이것들은 2단계에서 **도메인으로 등록**할 대상이다(가이드 §2.3 D1·D2).
3. 키·NULL 허용·코드성 여부를 함께 적어 사용자 확인을 받는다.

## 2. 이름 받기 — 자동완성 결과를 순위대로 처리

`table_name_suggest {logicalNm, bizAreaId}` → `tableNm`. `complete=false`면 미등록 조각을 4단계로 등록하고 다시 받는다.

`columns_autocomplete {logicalNms[], bizAreaId}`의 `items[i]`를 **위에서부터** 처리한다(위 단계가 되면 아래로 내려가지 않는다).

| 순위 | 상황 | 처리 | matchType |
|---|---|---|---|
| 1 | `exact` | `applied` 그대로. 타입·길이를 고치지 않는다 | EXACT |
| 2 | 코드성 컬럼(…코드, 구분·유형·상태·등급·종류·분류·판정) | `codeCandidates`에서 **같은 업무구분·맞는 코드값**의 코드구분을 고른다. 없으면 코드구분·코드값 등록안을 만든다(값을 모르면 묻는다) | CODE |
| 3 | `similar` 중 뜻이 같은 도메인 | 논리명을 그 도메인 논리명으로 **바꿔** 다시 자동완성 → exact | EXACT |
| 4 | 도메인 등록 대상(아래 D1~D4) | 도메인 등록안 → 등록 후 다시 자동완성 → exact | EXACT |
| 5 | 그 외 | `composed`의 `applied` 그대로 | COMPOSED |
| 6 | `unregistered` | 저장하지 않는다 → 4단계 용어 등록 후 다시 받는다 | — |

도메인 등록 대상(하나라도 해당하면 composed로 두지 않는다):
- D1 PK, FK·조인 키
- D2 프로젝트의 둘 이상 테이블에 나오는 컬럼
- D3 접미어 기본 타입·길이와 다른 타입이 필요한 컬럼
- D4 값 범위·단위·형식 규칙이 있는 컬럼

composed로 남기는 컬럼은 **"한 테이블 전용 · 기본 타입 · 키 아님"** 근거를 컬럼마다 기록한다.

하지 않는 것: 물리명·타입을 손으로 쓰기(MANUAL), similar 후보를 고르고 논리명을 그대로 두기(SIMILAR), 접미어가 없어 타입이 빈 composed에 타입 채우기(→ 도메인분류 등록).

코드성 컬럼 예외(코드구분 없이 도메인 EXACT로 둔다):
- 코드 마스터 테이블의 키(그 테이블 자체가 코드 목록) — 그 키를 참조하는 다른 테이블 컬럼도 같은 도메인으로 둔다.
- 외부 시스템이 정하는 열린 문자열 — 이름에 `코드`를 쓰지 말고 명·값 같은 접미어로 짓는다.
- 숫자 등급·상태(1 긴급·2 주의…)도 값이 정해져 있으면 코드구분에 연결한다. INT 도메인으로 우회하지 않는다.

## 3. 타입이 접미어 기본값과 달라야 할 때

순서대로 판단한다.
1. 다른 접미어로 해결되는가(번호 NO → 순번 SEQ 등). 1순위.
2. 프로젝트 전체에서 그 접미어 타입이 달라야 하면 도메인분류 타입 변경 + `domains_recalculate`(관리자, 사용자 확인).
3. 이 의미 하나만 다르면 MANUAL 타입 **도메인**을 만들고 도메인 설명에 사유를 적는다.
4. 컬럼 행에서 타입만 고치지 않는다(`W_DOMAIN_TYPE_CHANGED`).

## 4. 사전 등록 — 한 번에 모아 확인받는다

등록할 용어·도메인분류·도메인·코드구분·코드를 **한 표**로 보여 주고 확인을 받은 뒤 등록한다.

- 용어: `terms_check`(중복) → `standards_search`(비슷한 용어의 약어 관례) → 편집자 `term_request` / 관리자 `term_create`. 같은 뜻의 기존 용어가 있으면 그것을 쓴다.
- 도메인: `domain_classes_list` → `domain_calculate {nm1..nm7}` 미리보기(조각이 모두 등록 용어인지, 같은 논리명 도메인이 있는지) → `domain_create`.
- 코드구분: `code_class_create` → `code_create`. 빈 코드구분을 만들지 않는다.
- 등록 뒤 해당 컬럼을 **다시 자동완성**한다(물리명을 손으로 이어 붙이지 않는다).

## 5. 컬럼 확정과 저장

1. 기본컬럼: `default_column_set_get`의 컬럼을 **전부, 세트 순서대로, 끝에** 넣는다 — `defaultColId` 유지, matchType DEFAULT, `columnId` null. `table_create`는 자동으로 넣지 않는다.
   - 빼는 것은 **사용자가 지시한 경우에만**. 테이블 설명에 `기본컬럼 제외: <사유>`를 적는다(서버는 이 표시가 있으면 누락 경고를 내지 않는다).
   - 기본컬럼과 같은 물리명 컬럼을 따로 만들지 않는다. 기록 시점은 `최초등록일시`로 충분한지 먼저 본다.
2. PK는 반드시 둔다(NOT NULL). 업무상 필수 값은 NOT NULL.
3. `defaultVal`: 문자열은 따옴표 없이(`N`), 숫자는 그대로, 함수는 `CURRENT_TIMESTAMP`·`CURRENT_DATE`만.
4. `colComment`: 논리명 반복 대신 의미·단위·값 범위·코드구분(`설비 구분 (DP/001)`)·원천.
5. 테이블 설명: 무엇을 기록하는지, 한 행의 의미, 원천. 예외를 썼으면 그 사유.
6. `table_validate` → **오류 0 · 경고 0**을 만든다. 남기는 경고가 있으면 사유를 설명에 적고 보고한다.
7. `table_create {table:{bizAreaId, tableNm, tableLogicalNm, description}, columns:[…]}`. 수정은 `table_get` → 전체 columns(기존 `columnId` 유지) + `version`으로 `table_save`. 409 `E_VERSION_CONFLICT`면 다시 읽어 합친다.
8. `table_ddl {id, query:{dialect}}`로 DDL을 보여 준다.

## 6. 완료 보고 — 테이블마다

| 항목 | 내용 |
|---|---|
| 매칭 통계 | EXACT n · CODE n · COMPOSED n · DEFAULT n · SIMILAR 0 · MANUAL 0 |
| COMPOSED 사유 | 컬럼마다 D1~D4에 해당하지 않는 근거 |
| 사전 변경 | 등록한 용어·도메인·코드구분·도메인분류 |
| 예외 | 기본컬럼 제외·남긴 경고와 사유(없으면 없음) |
| 검증 | 오류 0 · 경고 0 |

## 7. 저장 전 점검표

- [ ] 테이블 물리명은 `table_name_suggest` 결과다.
- [ ] 테이블 설명에 목적·한 행의 의미·원천이 있다.
- [ ] PK가 있다.
- [ ] MANUAL·SIMILAR·UNREGISTERED 컬럼이 없다.
- [ ] 키·참조 컬럼과 여러 테이블에 나오는 컬럼은 모두 EXACT(도메인)다.
- [ ] COMPOSED 컬럼은 한 테이블 전용·기본 타입·키 아님이다.
- [ ] 코드성 컬럼은 CODE이거나 코드 마스터 키·열린 값 예외다.
- [ ] 기본 세트 기본컬럼이 끝에 모두 있다(또는 사용자 지시 + 설명에 사유).
- [ ] 기본값 형식이 맞다(따옴표 없음).
- [ ] `table_validate` 오류 0 · 경고 0.

삭제·확정(FINAL)·승인·반려·프로젝트/사용자 관리처럼 되돌리기 어려운 작업은 사용자 확인 없이 하지 않는다.
