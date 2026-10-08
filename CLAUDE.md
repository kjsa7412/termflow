# TermFlow 작업 규칙 (에이전트 공통)

## 명령 실행
- 셸 명령에 `cd`를 쓰지 않는다(`cd x && ...` 형태 포함). 복합 명령의 `cd`는 권한 승인 대기를 일으켜 백그라운드 작업이 멈춘다.
  - 대신 절대 경로를 쓴다: `git -C C:/project/termflow ...`, `pnpm -C C:/project/termflow ...`, `pnpm --filter @termflow/server ...`, `cat C:/project/termflow/apps/server/src/...`.
  - 파일 읽기·검색은 Read/Grep/Glob 도구를 우선한다.
- 문서·코드 수정은 Edit/Write 도구로 한다. `python - <<'EOF'` 같은 인라인 스크립트나 저장소 밖(스크래치패드 등) 경로의 스크립트 실행은 쓰지 않는다(승인 대기로 멈춘 사례가 있다). 보조 스크립트가 꼭 필요하면 저장소 안 `scripts/` 또는 gitignore된 `migration/work/`에 두고 실행한다.
- 한 Bash 호출에는 한 가지 목적의 명령만 넣는다. 파일 편집·커밋·검증을 `&&`로 길게 묶지 않는다.
- 장기 실행 프로세스(dev 서버 등)는 백그라운드로 띄우고 검증 후 종료한다.
- 테스트·빌드처럼 끝나는 명령은 백그라운드(run_in_background)로 돌리지 않는다. 서브에이전트는 완료 알림을 받지 못해 멈출 수 있다. foreground로 `timeout` 600000을 주고 실행하며, 더 오래 걸리면 필터로 나눠 실행한다.
- Docker가 꺼져 있으면 `docker info`로 확인하고 Docker Desktop 기동을 기다렸다가 재시도한다.

## 테스트 실행 원칙(과도한 반복 금지)
- 개발 중에는 고친 모듈의 테스트만 파일 필터로 돌린다(`pnpm -C C:/project/termflow test:db -- <필터>`). 전체 `test:db`는 게이트에서 한 번만.
- (사용자 요청으로 브랜치를 쓴 경우) main 병합 뒤 재검증은 조건부: 브랜치를 만든 뒤 main이 앞으로 나가지 않았으면(병합 결과 트리 = 브랜치 트리) 브랜치 게이트 결과를 그대로 인정하고 lint·typecheck만 확인한다. main이 앞으로 나갔으면 main을 브랜치에 먼저 합쳐 게이트를 한 번 돌린다.
- 같은 테스트를 통과 확인 목적으로 반복 실행하지 않는다. 불안정 테스트는 원인을 고치고 기록한다.

## 진행 규칙
- 절차는 `docs/03_TODO.md`를 따른다. 항목 완료 시 체크 `[x]` + 커밋 해시.
- 작업·커밋·푸시는 기본적으로 `main` 브랜치에서 한다(커밋 후 `git -C C:/project/termflow push origin main`). 별도 브랜치는 사용자가 요청할 때만 만든다. push마다 GitHub Actions CI(`.github/workflows/ci.yml`)가 돌므로 push 전에 고친 범위의 lint·typecheck·테스트를 로컬에서 확인한다.
- 태그는 버전 태그 `v{X.Y.Z}`만 쓴다. 단계 태그(`stage-*`)는 만들지 않는다.
- 버전 태그는 손으로 달지 않는다(CR-14 C11). 판을 올릴 때는 `package.json` version · `docker-compose.yml` `termflow-app:<판>` · `docs/릴리스_노트_v<판>.md`를 한 커밋에서 함께 고치고 `bash scripts/release-check.sh`로 확인한 뒤 main에 push한다. main CI(`ci.yml`)가 검사를 통과하면 `release.yml` 실행("v<판> 배포물")을 요청해 번들·태그·Release 초안까지 만든다(CR-17). 문서만 바꾼 push는 CI가 돌지 않는다. 판을 올리지 않는 커밋은 version을 건드리지 않는다.
- 항목 단위로 자주 커밋한다(사용량 한도·세션 종료로 중단될 수 있음). 재개 시 git 상태와 TODO 체크로 이어서 진행.
- 커밋 메시지는 한국어, 마지막 줄 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- 사용자 결정이 필요한 항목은 설계서·TODO의 권장안으로 처리하고 기록한다. 설계 수준 변경은 `docs/CR-{nn}_*.md`로 남긴다.

## 금지
- `seed/original/` 수정, `C:\project\gen_table_promotion` 열람·수정.
- AI 기능(채팅·추천·외부 LLM 호출) 구현. `pnpm check:no-ai` 게이트 유지.
- 비밀번호·비밀값을 문서나 커밋에 기록(`.env`는 커밋 금지).
