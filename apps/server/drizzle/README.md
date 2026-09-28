# 스키마 마이그레이션 규약 (설계서 §2.5.3, TODO T2.1·T2.2, `docs/PoC_결과.md` T1.2~T1.4)

## 원칙

- **SQL 파일이 진실이다.** 스키마는 이 폴더의 `000n_*.sql`만으로 정의한다. `src/db/schema.ts`는 DB에서 역생성한 쿼리 타입용 사본이다.
- **diff 기반 `drizzle-kit generate`·`push`는 쓰지 않는다**(진실 이원화 방지). schema.ts를 고쳐 SQL을 만드는 흐름은 없다.
- **전진 전용.** down 마이그레이션은 없다. 적용된 파일은 수정·삭제하지 않고 새 번호 파일로 고친다. 운영 복구는 백업(§12.4).
- `0001_baseline.sql` = 설계서 부록 A 전문(내용 변경 금지, 상단 주석에 출처 버전).

## 명령

| 명령                                           | 동작                                                                                                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm db:migrate`                              | 미적용 파일을 한 트랜잭션에서 적용(`drizzle.__drizzle_migrations`). 서버 기동(`main.ts`)도 같은 함수를 먼저 실행하고 실패하면 기동하지 않는다 |
| `pnpm --filter @termflow/server db:new <이름>` | 다음 번호 `000n_<이름>.sql`(빈 파일) + `meta/_journal.json` 항목 추가                                                                         |
| `pnpm db:pull`                                 | DB → `src/db/schema.ts` 재생성(drizzle-kit pull → FK 제거 후처리 → prettier). 마이그레이션 적용 후 실행해 커밋                                |
| `pnpm db:reset`                                | dev 전용: `public`·`drizzle` 스키마 삭제 후 재적용(production 거부)                                                                           |

## 안전장치(PoC 발견 → T2.1)

- 적용 전 **해시 대조**: 이미 적용된 파일의 내용이 바뀌었거나 파일이 없으면 `MigrationIntegrityError`로 중단(drizzle migrator 자체는 검증하지 않음).
- **advisory lock**으로 동시 기동 시 마이그레이션을 직렬화.
- 실패 시 전체 롤백(이력 미기록, 부분 객체 없음).

## schema.ts가 담지 않는 것(pull 한계, PoC T1.4)

- FOREIGN KEY 전부(복합 FK 열 순서 오류·`ON DELETE SET NULL (열)` 누락·순환 참조 타입 오류) → 관계는 `src/db/relations.ts`(수기)
- DEFERRABLE, 다열 unique 열 순서(attnum 순으로 나올 수 있음), TIMESTAMP 정밀도
- `timestamp(..., { mode: 'string' })`로 생성되므로 시각 값은 문자열(`YYYY-MM-DD HH:MM:SS`, Asia/Seoul)로 다룬다

## 절차: 스키마 변경

1. `pnpm --filter @termflow/server db:new add_xxx` → SQL 작성
2. `pnpm db:migrate` → `pnpm db:pull` → `pnpm typecheck`
3. SQL·journal·schema.ts를 한 커밋으로
