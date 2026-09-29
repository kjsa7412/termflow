# 표준 사전 모듈 패턴 (T6.1)

단계 6에서 고정한 서버 모듈 패턴이다. 이후 모듈(테이블·DDL·자동완성)도 같은 구성을 따른다.
설계 근거: 설계서 §8.5(감사), §8.6(감사컬럼), §5.1(캐시 무효화), §9.1(목록 규약), §12.2(SQL 인젝션), §7.3(권한).

## 1. 계층

| 계층       | 파일                                                    | 책임                                                                                |
| ---------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 컨트롤러   | `standard.controller.ts`, `import/import.controller.ts` | 경로·권한(`@ProjectRole`)·zod 파이프(400)·201 Location. 업무 규칙 없음              |
| 서비스     | `term.service.ts` 등                                    | 정규화 → 업무 검증(422) → 중복(409) → `StdWriter.write` 트랜잭션 → 응답 조립        |
| 순수 규칙  | `domain-plan.ts`, `@termflow/shared` 검증 함수          | DB·Nest를 모르는 함수. API·일괄 등록·재계산이 같은 함수를 쓴다(규칙 이중 구현 금지) |
| SQL 도우미 | `std-sql.ts`                                            | 정렬 화이트리스트 → ORDER BY, LIMIT/OFFSET, 조건 결합                               |

## 2. 쓰기 = `StdWriter.write(ctx, tx => …)`

```ts
this.writer.assertWritable(ctx);            // 보관 409 · 템플릿은 SA만(가드와 이중 검사)
const v = normalize(input);                 // trim·대문자 정규화 + 422(errors[])
if (await exists(v.key)) throw dup(...);    // 409 E_*_DUP (+ 기존 행 ID 확장 필드)
await this.writer.write(ctx, async (tx) => {
  const [r] = await insertAudited(tx, table, {...}, a).onConflictDoNothing().returning();
  if (!r) throw dup(...);                   // 동시 등록 경합도 409
  await writeStdAudit(tx, { entityType, entityId, action: 'INSERT', after: auditJson(r) }, a);
});                                          // 커밋 후 TermCacheRegistry.invalidate(projectId) — 롤백이면 호출 안 함
```

- 감사: 같은 트랜잭션에서 `writeStdAudit`, before/after는 `auditJson(row)`(감사 컬럼 6개 제외). UPDATE·DELETE는 변경 전 행을 먼저 읽어 둔다.
- 일괄(엑셀 적용·재계산): 행당 1건, action `IMPORT`, 같은 `batch_id`. 감사 insert는 1,000행씩 나뉜다(파라미터 상한).
- 감사 컬럼은 `insertAudited`/`updateAudited`만 쓴다(`Audit` 인자 필수 — 누락은 컴파일 오류).
- 대량 UPDATE는 `unnest(배열…)` 1문장(재계산·일괄 등록). 파라미터는 `sql.param(array)::type[]` 바인딩.
- 긴 작업(일괄 등록 적용)은 `assertWritableNow`로 DB 상태를 다시 확인한다(미리보기 이후 보관될 수 있음).

## 3. 목록 = 검색 · 필터 · 정렬 화이트리스트 · 페이지

- 쿼리 스키마: `pageQuerySchema.extend({ q, 필터…, sort: sortQuerySchema })`(shared). size 최대 200.
- 정렬: `orderBy(q.sort, SORTS, 기본, PK)` — `SORTS`는 코드에 고정한 `sql` 조각. 밖이면 400 `E_SORT_FIELD`.
- 검색: `ilike ${likePattern(q)}`(`%`·`_`·`\` 이스케이프). 식별자·정렬 문자열을 SQL에 넣지 않는다(`sql.raw` 금지).
- 응답: `{ items, page, size, total, counts }` — `counts`는 세그먼트(상태 필터) 건수이며 검색어만 반영한다.
- 시각은 `isoTs(col)`(서버 로컬 `YYYY-MM-DDTHH:mm:ss`).

## 4. 오류 코드

| 상태 | 언제                                  | 예                                                                              |
| ---- | ------------------------------------- | ------------------------------------------------------------------------------- |
| 400  | 스키마(타입·길이·enum)                | zod 파이프 `E_FORMAT`                                                           |
| 404  | 다른 프로젝트·없는 ID(존재 노출 방지) | `E_NOT_FOUND`                                                                   |
| 409  | 자연키 중복·상태 충돌·사용 중         | `E_TERM_DUP`, `E_DOMAIN_CLS_IN_USE`, `E_TERM_NOT_PENDING`, `E_PROJECT_READONLY` |
| 422  | 업무 규칙(형식·길이 규칙·필수 조합)   | `E_TERM_PHYSICAL_FORMAT`, `E_TYPE_LEN_MISSING`, `E_BIZ_AREA_INACTIVE`           |

- 확장 필드 이름은 `code`를 쓰지 않는다(ProblemDetail.code와 겹침 — 예: `codeValue`).
- 저장은 되지만 알릴 것은 성공 응답 `warnings[]`(예: `W_TERM_PHYSICAL_SHARED`, `W_DOMAIN_RECALC_NEEDED`).

## 5. 권한(§7.3)

- 조회(GET) = 조회자 이상(`@ProjectRole('VIEWER')`), 쓰기 = 프로젝트 관리자(`'ADMIN'`). 시스템 관리자는 모든 프로젝트·템플릿에서 ADMIN.
- 비멤버·비SA의 템플릿은 가드가 404, 보관 프로젝트 쓰기는 가드와 서비스가 409.
- 새 경로를 추가하면 `test/api/authz-matrix.ts`에 행을 추가한다.

## 6. 테스트

- API: `test/db/standard.test.ts`(용어~검색, 보관·템플릿·격리), `test/db/import.test.ts`(일괄 등록·20,000행 벤치),
  `test/db/standard-stdv1.test.ts`(STDV1 실데이터: 재계산·목록 성능), 권한은 `authz-matrix`.
- 순수 규칙: `test/unit/domain-plan.test.ts`.
