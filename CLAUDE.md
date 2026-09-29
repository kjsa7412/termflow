# TermFlow 작업 규칙 (에이전트 공통)

## 명령 실행
- 셸 명령에 `cd`를 쓰지 않는다(`cd x && ...` 형태 포함). 복합 명령의 `cd`는 권한 승인 대기를 일으켜 백그라운드 작업이 멈춘다.
  - 대신 절대 경로를 쓴다: `git -C C:/project/termflow ...`, `pnpm -C C:/project/termflow ...`, `pnpm --filter @termflow/server ...`, `cat C:/project/termflow/apps/server/src/...`.
  - 파일 읽기·검색은 Read/Grep/Glob 도구를 우선한다.
- 문서·코드 수정은 Edit/Write 도구로 한다. `python - <<'EOF'` 같은 인라인 스크립트나 저장소 밖(스크래치패드 등) 경로의 스크립트 실행은 쓰지 않는다(승인 대기로 멈춘 사례가 있다). 보조 스크립트가 꼭 필요하면 저장소 안 `scripts/` 또는 gitignore된 `migration/work/`에 두고 실행한다.
- 한 Bash 호출에는 한 가지 목적의 명령만 넣는다. 파일 편집·커밋·검증을 `&&`로 길게 묶지 않는다.
- 장기 실행 프로세스(dev 서버 등)는 백그라운드로 띄우고 검증 후 종료한다.
- Docker가 꺼져 있으면 `docker info`로 확인하고 Docker Desktop 기동을 기다렸다가 재시도한다.

## 진행 규칙
- 절차는 `docs/03_TODO.md`를 따른다. 항목 완료 시 체크 `[x]` + 커밋 해시.
- 단계 브랜치 `stage/{N}-{slug}`, 게이트 통과 시 main에 `--no-ff` 병합 + `git tag stage-{N}`.
- 항목 단위로 자주 커밋한다(사용량 한도·세션 종료로 중단될 수 있음). 재개 시 git 상태와 TODO 체크로 이어서 진행.
- 커밋 메시지는 한국어, 마지막 줄 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- 사용자 결정이 필요한 항목은 설계서·TODO의 권장안으로 처리하고 기록한다. 설계 수준 변경은 `docs/CR-{nn}_*.md`로 남긴다.

## 금지
- `seed/original/` 수정, `C:\project\gen_table_promotion` 열람·수정.
- AI 기능(채팅·추천·외부 LLM 호출) 구현. `pnpm check:no-ai` 게이트 유지.
- 비밀번호·비밀값을 문서나 커밋에 기록(`.env`는 커밋 금지).
