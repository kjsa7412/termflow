# TermFlow (텀플로)

표준 용어를 관리하고, 용어로 컬럼을 자동완성해 테이블을 설계하고, DDL까지 한 흐름으로 생성하는 다중 사용자·프로젝트 기반 데이터 표준 설계 서비스.

- 전신: gen-table v1.0.0 (`C:\project\gen_table_promotion`, 읽기 전용 참조)
- 문서: `docs/00_네이밍.md`, `docs/01_검토안.md`, `docs/02_설계서.md`, `docs/03_TODO.md`, `docs/mockups/`
- 시드 데이터: `seed/original/` (원본 SQL 복사본, 수정 금지) → 정제본은 `seed/`에 생성 예정

## 개발 환경 실행

### 선행 조건

| 도구           | 버전                              | 확인                    |
| -------------- | --------------------------------- | ----------------------- |
| Node.js        | 22 LTS (`.node-version`)          | `node -v` → `v22.x`     |
| pnpm           | 10.33.0 (`packageManager`로 고정) | `pnpm -v` → `10.33.0`   |
| Docker Desktop | 데몬 기동 상태, Compose v2 이상   | `docker info` 오류 없음 |

- pnpm은 `corepack enable`(관리자 셸) 또는 `npm i -g pnpm@10.33.0`으로 준비한다. 다른 버전이 설치돼 있어도 `packageManager` 필드에 맞춰 10.33.0으로 실행된다.
- pnpm 10은 의존성의 설치 스크립트를 기본 차단한다. 허용 목록은 루트 `package.json`의 `pnpm.onlyBuiltDependencies`에 있다.

### 처음 한 번

```bash
pnpm install                 # 의존성 설치 + packages/shared 빌드(prepare)
cp .env.example .env         # 빈 값(TERMFLOW_DB_PASSWORD, TERMFLOW_ADMIN_PASSWORD 등)을 개발용 임의값으로 채운다
```

`.env`는 커밋하지 않는다. 필수 값이 비어 있으면 서버가 누락 변수명을 출력하고 종료 코드 1로 끝난다.

### 기동

```bash
docker compose up -d db      # PostgreSQL 17(termflow-db), healthy까지 수 초
pnpm db:migrate              # 스키마 적용(서버 기동 시에도 자동 적용, 실패하면 기동 안 함)
pnpm dev                     # shared 빌드 후 shared(watch)·server(nest build --watch + node --watch)·web(vite) 동시 기동
```

- 서버 확인: `curl -s localhost:8080/health` → `{"status":"ok","info":{"db":{"status":"up"}},...}` (200, DB가 응답하지 않으면 503)
- 웹 확인: 브라우저에서 <http://localhost:5173> → 로그인 화면
- 첫 로그인: `tf_user`가 비어 있으면 서버 기동 시 초기 시스템 관리자를 만든다 — 아이디 `.env`의 `TERMFLOW_ADMIN_LOGIN`, 비밀번호 `TERMFLOW_ADMIN_PASSWORD`. 첫 로그인에서 비밀번호 변경이 강제된다(이후 사용자는 [시스템 › 사용자]에서 만든다)
- 프로덕션 모드 확인: `pnpm build && node apps/server/dist/main.js` → <http://localhost:8080>(웹 빌드를 같은 포트에서 제공, 새로고침해도 index.html)
- 종료: `pnpm dev` 터미널에서 Ctrl+C, DB는 `docker compose stop db`

### 포트

| 포트 | 용도                                  | 비고                                       |
| ---- | ------------------------------------- | ------------------------------------------ |
| 5173 | 웹 개발 서버(Vite, HMR)               | `/api`·`/health` → 8080 프록시             |
| 8080 | API 서버(NestJS)                      | `GET /health`, 업무 API는 `/api/v1/**`     |
| 5434 | PostgreSQL(`termflow-db`) 호스트 포트 | 컨테이너 내부 5432, 볼륨 `termflow-pgdata` |

### 품질 게이트

```bash
pnpm lint          # ESLint + Prettier 검사 + check:no-ai
pnpm typecheck     # tsc / vue-tsc --noEmit (전 패키지)
pnpm test          # Vitest 단위·API 테스트(컨테이너 불필요)
pnpm check:no-ai   # AI 관련 문자열 0건 확인(설계서 §1.2)
```

```bash
pnpm test:db       # Testcontainers(postgres:17, Docker 필요): 스키마 제약·마이그레이션·헬스·감사 통합 테스트
pnpm test:db -- schema   # 파일 이름 필터(pnpm 10의 `--` 전달은 scripts/run-vitest.mjs가 처리)
```

### DB 명령

| 명령                                           | 동작                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| `pnpm db:migrate`                              | `apps/server/drizzle/000n_*.sql` 미적용분 적용(적용 파일 해시 대조) |
| `pnpm db:pull`                                 | DB → `apps/server/src/db/schema.ts` 재생성(FK 제거 후처리)          |
| `pnpm db:reset`                                | dev 전용: 스키마 삭제 후 재적용(production 거부)                    |
| `pnpm --filter @termflow/server db:new <이름>` | 다음 번호 빈 마이그레이션 파일 생성                                 |

규약은 `apps/server/drizzle/README.md`.

### 초기 데이터 승계(1차: legacy → 템플릿 STDV1)

```bash
pnpm --filter @termflow/server migrate:scan   # dump 민감값 사전 점검 → migration/report/sensitive-scan.csv
pnpm migrate:seed                             # 기본 --steps=LOAD_LEGACY..DEFAULT_COL + RECONCILE(1차 대사)
pnpm migrate:seed -- --reset                  # dev 전용: STDV1·RMS·legacy 삭제 후 처음부터(멱등 확인용)
pnpm migrate:seed -- --steps=RECONCILE        # 대사만 다시
pnpm migrate:seed -- --steps=TERM_UNIFY,RECONCILE,DDL_REGRESSION   # CR-09 이전 이름(…_MST·…_REG_USER_ID)으로 적재된 DB 정정
pnpm --filter @termflow/server cr09:sql       # 운영 DB 전환 스크립트 docs/cr09_rename_postgresql.sql 재생성
```

- 원본: `seed/original/dump-gen_table-new.sql`(수정 금지) → 치환본 `migration/work/dump-legacy.sql` → 스키마 `legacy`
- 리포트: `migration/report/{run_id}/`의 규칙별 `rNN_*.csv`·`cr09-rename-map.csv`(R19 이전 → 이후)·`summary.csv`·`reconcile.csv`(UTF-8 BOM, 엑셀에서 바로 열림)
- 이미 적재된 step은 SKIPPED, 실패·대사 불일치면 종료 코드 1. 실행 기록은 `migration_log`
- 규칙·기대 건수와 설계 대비 차이는 `docs/CR-03_단계3_4_구현반영.md`

### 저장소 구조

```text
apps/server/       NestJS 서버(Express 어댑터, ESM)
apps/web/          Vue 3 + Vite SPA
packages/shared/   서버·웹 공용 상수·타입(@termflow/shared)
scripts/           저장소 점검 스크립트(check-no-ai.mjs)
docker-compose.yml db 서비스(app 서비스는 배포 단계에서 추가)
```
