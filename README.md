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
pnpm dev                     # shared 빌드 후 shared(watch)·server(nest --watch)·web(vite) 동시 기동
```

- 서버 확인: `curl -s localhost:8080/health` → `{"status":"ok",...}` (200)
- 웹 확인: 브라우저에서 <http://localhost:5173> → `TermFlow · server ok`
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

`pnpm test:db`(Testcontainers), `pnpm db:migrate`, `pnpm db:pull`, `pnpm migrate:seed`는 단계 1~3에서 구현한다(현재는 자리만).

### 저장소 구조

```text
apps/server/       NestJS 서버(Express 어댑터, ESM)
apps/web/          Vue 3 + Vite SPA
packages/shared/   서버·웹 공용 상수·타입(@termflow/shared)
scripts/           저장소 점검 스크립트(check-no-ai.mjs)
docker-compose.yml db 서비스(app 서비스는 배포 단계에서 추가)
```
