#!/usr/bin/env bash
# TermFlow 실행(Linux, start.ps1 이식 — 설계서 §12.6, T12.2). 최초 설치는 install.sh가 이 스크립트를 부른다.
#
# 순서: ① Docker 확인 → ② .env 존재·필수 변수 → ③ db 기동·healthy 대기
#       → ④ 승계 실행 여부 질문(최초 1회) → ⑤ app 기동·healthy 대기 → ⑥ 접속 주소 출력
# 문제가 있으면 안내를 출력하고 종료 코드 1로 끝난다.
#
# 옵션(start.ps1과 같은 뜻):
#   --migrate ask|yes|no   ask(기본) = 승계가 아직이면 묻는다 · yes = 묻지 않고 실행 · no = 건너뛴다
#   --migrate-all          승계를 1~12 한 번에(설계서 §11.5 대안, CR-11 C2). 생략하면 2단계(1차 1~8 → 정정 → 2차 9~12)
#   --build                app 이미지를 다시 빌드한다(업그레이드 시, 소스가 있어야 한다)
#   --timeout 초           서비스별 healthy 대기 상한(기본 300)
#
# 예: ./start.sh            ./start.sh --migrate yes --migrate-all            ./start.sh --build --migrate no
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE=(docker compose --project-directory "$ROOT" -f "$ROOT/docker-compose.yml")
REQUIRED_VARS=(TERMFLOW_DB_PASSWORD TERMFLOW_ADMIN_PASSWORD TERMFLOW_SESSION_SECRET)
SESSION_SECRET_MIN_BYTES=32
LEGACY_DUMP="$ROOT/seed/original/dump-gen_table-new.sql"
REPORT_DIR="$ROOT/migration/report"

MIGRATE=ask
MIGRATE_ALL=0
BUILD=0
TIMEOUT=300

if [ -t 1 ]; then C_STEP=$'\e[36m' C_OK=$'\e[32m' C_ERR=$'\e[31m' C_END=$'\e[0m'; else C_STEP='' C_OK='' C_ERR='' C_END=''; fi
step() { printf '\n%s[TermFlow] %s%s\n' "$C_STEP" "$1" "$C_END"; }
ok() { printf '%s  - %s%s\n' "$C_OK" "$1" "$C_END"; }
info() { printf '  - %s\n' "$1"; }
die() {
  printf '\n' >&2
  local l
  for l in "$@"; do printf '%s[TermFlow] %s%s\n' "$C_ERR" "$l" "$C_END" >&2; done
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --migrate)
      [ $# -ge 2 ] || die '--migrate 다음에 ask|yes|no 중 하나를 쓰세요.'
      case "$2" in ask | yes | no) MIGRATE="$2" ;; *) die "--migrate 값은 ask|yes|no 입니다: $2" ;; esac
      shift 2
      ;;
    --migrate=*)
      MIGRATE="${1#*=}"
      case "$MIGRATE" in ask | yes | no) ;; *) die "--migrate 값은 ask|yes|no 입니다: $MIGRATE" ;; esac
      shift
      ;;
    --migrate-all) MIGRATE_ALL=1 && shift ;;
    --build) BUILD=1 && shift ;;
    --timeout)
      [ $# -ge 2 ] || die '--timeout 다음에 초를 쓰세요.'
      TIMEOUT="$2" && shift 2
      ;;
    --timeout=*) TIMEOUT="${1#*=}" && shift ;;
    -h | --help)
      sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "알 수 없는 옵션: $1 (도움말: ./start.sh --help)" ;;
  esac
done
case "$TIMEOUT" in '' | *[!0-9]*) die "--timeout 은 10~1800 사이 정수입니다: $TIMEOUT" ;; esac
{ [ "$TIMEOUT" -ge 10 ] && [ "$TIMEOUT" -le 1800 ]; } || die "--timeout 은 10~1800 사이 정수입니다: $TIMEOUT"

# .env를 KEY=VALUE로 읽어 DOTENV_<KEY>에 둔다(주석·빈 줄 무시, 값 양끝 따옴표 제거). compose와 같은 해석만 흉내 낸다.
# 값은 화면에 내지 않는다.
DOTENV_KEYS=()
read_dotenv() {
  local raw line key val
  while IFS= read -r raw || [ -n "$raw" ]; do
    line="${raw%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    case "$line" in *=*) ;; *) continue ;; esac
    key="${line%%=*}"
    val="${line#*=}"
    key="${key#export }"
    key="${key%"${key##*[![:space:]]}"}"
    key="${key#"${key%%[![:space:]]*}"}"
    case "$key" in '' | *[!A-Za-z0-9_]*) continue ;; esac
    val="${val#"${val%%[![:space:]]*}"}"
    if [ "${#val}" -ge 2 ]; then
      case "$val" in \"*\" | \'*\') val="${val:1:${#val}-2}" ;; esac
    fi
    printf -v "DOTENV_$key" '%s' "$val"
    DOTENV_KEYS+=("$key")
  done <"$1"
}
dotenv() {
  local n="DOTENV_$1"
  printf '%s' "${!n-}"
}

container_id() { "${COMPOSE[@]}" ps -q "$1" 2>/dev/null | head -n1; }

# 컨테이너 healthcheck가 healthy가 될 때까지 기다린다. unhealthy·종료면 즉시 실패.
wait_healthy() {
  local svc="$1" deadline=$((SECONDS + TIMEOUT)) last='' id state
  while [ "$SECONDS" -lt "$deadline" ]; do
    id="$(container_id "$svc")"
    if [ -n "$id" ]; then
      state="$(docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id" 2>/dev/null)"
      if [ "$state" != "$last" ]; then
        info "$svc 상태: $state"
        last="$state"
      fi
      case "$state" in
        running/healthy) return 0 ;;
        running/unhealthy | exited/* | dead/*) return 1 ;;
      esac
    fi
    sleep 2
  done
  info "$svc 대기 시간 초과(${TIMEOUT}초)"
  return 1
}

# app 기동·healthy 대기(⑤). 승계 전에 초기 관리자를 만들어야 할 때(--migrate-all·2차) ④에서 먼저 부를 수 있다.
APP_STARTED=0
start_app() {
  [ "$APP_STARTED" = 1 ] && return 0
  local args=(up -d)
  [ "$BUILD" = 1 ] && args+=(--build)
  args+=(app)
  info '이미지가 없으면 처음 한 번 빌드합니다(수 분 걸릴 수 있습니다).'
  "${COMPOSE[@]}" "${args[@]}" || die 'app 서비스를 시작하지 못했습니다. 위 docker 메시지를 확인하세요(포트 충돌이면 .env의 TERMFLOW_APP_PORT).'
  if ! wait_healthy app; then
    "${COMPOSE[@]}" logs --tail 60 app
    die 'app이 healthy 상태가 되지 않았습니다. 위 로그(환경 변수 검증·마이그레이션 오류)를 확인하세요.'
  fi
  APP_STARTED=1
  ok "app healthy ($APP_URL/health)"
}

# 초기 관리자(TERMFLOW_ADMIN_LOGIN) 활성 사용자 존재 여부. 스키마가 아직 없으면 없음(1).
admin_exists() {
  local login="$1" n
  case "$login" in '' | *[!A-Za-z0-9._-]*) return 0 ;; esac # 판정 불가 — 러너가 직접 검사한다
  n="$("${COMPOSE[@]}" exec -T db psql -U termflow -d termflow -tAc "select count(*) from tf_user where login_id = '$login' and is_active" 2>/dev/null | tr -d '[:space:]')"
  [ -n "$n" ] && [ "$n" != 0 ]
}

# ---------- ① Docker 확인 ----------
step '① Docker 확인'
command -v docker >/dev/null 2>&1 || die 'docker 명령을 찾을 수 없습니다. Docker Engine과 compose 플러그인을 설치한 뒤 다시 실행하세요.' \
  '  https://docs.docker.com/engine/install/  (설치·운영 가이드 §14)'
if ! docker info >/dev/null 2>&1; then
  die 'Docker가 실행 중이 아니거나 이 사용자에게 권한이 없습니다(docker info 실패).' \
    '  sudo systemctl start docker  — 또는 이 사용자를 docker 그룹에 넣고(sudo usermod -aG docker <사용자>) 다시 로그인하세요.'
fi
docker compose version >/dev/null 2>&1 || die 'docker compose(v2) 플러그인을 쓸 수 없습니다. docker-compose-plugin 패키지를 설치하세요.'
ok 'Docker 데몬 응답'

# ---------- ② .env ----------
step '② .env 확인'
ENV_FILE="$ROOT/.env"
if [ ! -f "$ENV_FILE" ]; then
  die ".env 파일이 없습니다: $ENV_FILE" \
    '  처음 설치라면 ./install.sh 가 비밀값을 만들어 .env를 씁니다.' \
    '  직접 만들려면: cp .env.example .env 후 다음 값을 채웁니다: '"${REQUIRED_VARS[*]}" \
    "     (TERMFLOW_SESSION_SECRET은 ${SESSION_SECRET_MIN_BYTES}바이트 이상 난수)"
fi
read_dotenv "$ENV_FILE"
PROBLEMS=()
for name in "${REQUIRED_VARS[@]}"; do
  [ -n "$(dotenv "$name")" ] || PROBLEMS+=("  - $name : 값이 비어 있습니다")
done
# 값 자리에 주석이 들어간 경우(KEY=   # 설명) — compose가 "# 설명"을 값으로 읽는다(CR-11a C4)
for key in "${DOTENV_KEYS[@]}"; do
  case "$(dotenv "$key")" in \#*) PROBLEMS+=("  - $key : 값이 '#'로 시작합니다. 주석은 별도 줄에 쓰세요") ;; esac
done
SECRET="$(dotenv TERMFLOW_SESSION_SECRET)"
if [ -n "$SECRET" ]; then
  SECRET_BYTES="$(printf '%s' "$SECRET" | wc -c | tr -d '[:space:]')"
  [ "$SECRET_BYTES" -ge "$SESSION_SECRET_MIN_BYTES" ] ||
    PROBLEMS+=("  - TERMFLOW_SESSION_SECRET : ${SESSION_SECRET_MIN_BYTES}바이트 이상이어야 합니다(현재 ${SECRET_BYTES}바이트)")
fi
if [ "${#PROBLEMS[@]}" -gt 0 ]; then
  die ".env 필수 값을 확인하세요: $ENV_FILE" "${PROBLEMS[@]}" \
    '  세션 키 만들기(64자): openssl rand -hex 32   (또는 head -c 32 /dev/urandom | od -An -tx1 | tr -d " \n")'
fi
ok ".env 필수 변수 ${#REQUIRED_VARS[@]}개 확인"

# 호스트 포트: 셸 환경 변수 > .env > 기본값(compose 변수 치환과 같은 우선순위)
APP_PORT="${TERMFLOW_APP_PORT:-$(dotenv TERMFLOW_APP_PORT)}"
APP_PORT="${APP_PORT:-8080}"
APP_URL="http://localhost:$APP_PORT"

# bind mount 대상(없으면 Docker가 root 소유로 만든다 — 미리 만들어 app(이미지의 node 사용자, uid 1000)이 쓸 수 있게 둔다).
# Linux는 bind mount 권한이 호스트 그대로라, 쓰기 못 하면 app이 로그 파일을 열지 못하고 멈춘다.
APP_UID=1000
for d in logs migration/report backup; do mkdir -p "$ROOT/$d"; done
for d in logs migration/report; do
  if [ "$(id -u)" = 0 ]; then
    chown "$APP_UID:$APP_UID" "$ROOT/$d" && chmod 750 "$ROOT/$d"
  elif [ "$(stat -c %u "$ROOT/$d" 2>/dev/null)" != "$APP_UID" ] && [ "$(uname -s)" = Linux ]; then
    # 설치 사용자 ≠ uid 1000: 소유자를 바꿀 수 없으니 쓰기를 연다(설치 폴더 자체는 그 사용자만 들어오게 두는 것을 권장)
    chmod 0777 "$ROOT/$d" 2>/dev/null || info "$d 폴더에 uid $APP_UID 쓰기 권한을 줄 수 없습니다(sudo chown $APP_UID:$APP_UID $ROOT/$d)"
  fi
done

# ---------- ③ db ----------
step '③ DB 기동(db)'
"${COMPOSE[@]}" up -d db || die 'db 서비스를 시작하지 못했습니다. 위 docker 메시지를 확인하세요(포트 충돌이면 .env의 TERMFLOW_DB_PORT).'
if ! wait_healthy db; then
  "${COMPOSE[@]}" logs --tail 40 db
  die 'db가 healthy 상태가 되지 않았습니다. 위 로그를 확인하세요.'
fi
ok 'db healthy'

# ---------- ④ 승계(최초 1회) ----------
step '④ 데이터 승계 확인'
# 승계 상태: STDV1(1차 결과)·RMS(2차 결과) 프로젝트 존재 여부. 스키마가 아직 없으면(최초) 빈 값.
FOUND="$("${COMPOSE[@]}" exec -T db psql -U termflow -d termflow -tAc \
  "select coalesce(string_agg(project_key, ',' order by project_key), '') from tf_project where project_key in ('STDV1','RMS')" 2>/dev/null | tr -d '[:space:]')"
has_key() { case ",$FOUND," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
PLAN_LABEL=''
PLAN_ARGS=()
PLAN_NEED_ADMIN=0
if ! has_key STDV1 && [ "$MIGRATE_ALL" = 1 ]; then
  PLAN_LABEL='승계 한 번에 실행(LOAD_LEGACY..DDL_REGRESSION, §11.5 대안) — STDV1·RMS·33 테이블·대사·DDL 회귀. 정정은 실행 후 두 곳에서'
  PLAN_ARGS=(--steps=LOAD_LEGACY..DDL_REGRESSION)
  PLAN_NEED_ADMIN=1
elif ! has_key STDV1; then
  PLAN_LABEL='1차 승계(LOAD_LEGACY..DEFAULT_COL + 대사) — 원본 dump → STDV1 표준 사전'
elif ! has_key RMS; then
  PLAN_LABEL='2차 승계(COPY_TO_RMS..DDL_REGRESSION) — STDV1 정정 반영 후 RMS 생성·33 테이블·DDL 회귀'
  PLAN_ARGS=(--steps=COPY_TO_RMS..DDL_REGRESSION)
  PLAN_NEED_ADMIN=1
fi
if [ -z "$PLAN_LABEL" ]; then
  ok '승계 완료 상태(STDV1·RMS 존재) — 건너뜀'
else
  info "미실행: $PLAN_LABEL"
  RUN=0
  if [ "$MIGRATE" = yes ]; then
    RUN=1
  elif [ "$MIGRATE" = ask ]; then
    if [ -t 0 ]; then
      read -r -p '  지금 실행할까요? (y/N) ' ANSWER
      case "$ANSWER" in y | Y | yes | YES | ㅛ) RUN=1 ;; esac
    else
      info '입력이 없는 실행이라 건너뜁니다(--migrate yes로 실행 가능).'
    fi
  fi
  if [ "$RUN" = 0 ]; then
    info '승계를 건너뜁니다. 나중에 다시 ./start.sh 를 실행하면 다시 묻습니다.'
  else
    [ -f "$LEGACY_DUMP" ] || die "승계 원본이 없습니다: $LEGACY_DUMP"
    ADMIN_LOGIN="$(dotenv TERMFLOW_ADMIN_LOGIN)"
    ADMIN_LOGIN="${ADMIN_LOGIN:-admin}"
    if [ "$PLAN_NEED_ADMIN" = 1 ] && ! admin_exists "$ADMIN_LOGIN"; then
      info "RMS 프로젝트 관리자로 쓸 초기 관리자($ADMIN_LOGIN)가 아직 없어 app을 먼저 기동합니다(§7.5 부트스트랩)."
      start_app
    fi
    RUN_ARGS=(run --rm)
    [ "$BUILD" = 1 ] && [ "$APP_STARTED" = 0 ] && RUN_ARGS+=(--build)
    RUN_ARGS+=(app node apps/server/dist/migration/seed.js)
    [ "${#PLAN_ARGS[@]}" -gt 0 ] && RUN_ARGS+=("${PLAN_ARGS[@]}")
    info '승계 러너 실행(이미지가 없으면 먼저 빌드합니다. 수 분 걸릴 수 있습니다)'
    "${COMPOSE[@]}" "${RUN_ARGS[@]}" || die '승계 러너가 실패했습니다. 위 출력과 리포트를 확인하세요.' "  리포트: $REPORT_DIR"
    ok "승계 완료. 리포트: $REPORT_DIR"
  fi
fi

# ---------- ⑤ app ----------
step '⑤ 앱 기동(app)'
if [ "$APP_STARTED" = 1 ]; then ok "app healthy ($APP_URL/health) — ④에서 기동함"; else start_app; fi

# ---------- ⑥ 접속 ----------
step "⑥ 접속: $APP_URL  (다른 PC에서는 http://<이 서버 주소>:$APP_PORT)"
info '로그인 화면이 보이면 정상입니다. 사용 안내는 로그인 화면의 [사용자 가이드](/manual).'
info '중지: docker compose stop   /   로그: docker compose logs -f app   /   백업: scripts/backup.sh'
exit 0
