#!/usr/bin/env bash
# TermFlow Linux 설치(T12.3, CR-12 C6~C9). 설치 폴더(이 파일이 있는 폴더, 예 /opt/termflow)에서 한 번 실행한다.
#
# 순서: ① 환경 확인(Linux·Docker·compose) → ② 오프라인 이미지 적재(images/*.tar.gz가 있으면)
#       → ③ .env 생성(없을 때만, 비밀값 난수·권한 600·화면 출력 없음) → ④ 이미지 확인
#       → ⑤ systemd 등록(부팅 시 기동·매일 02:00 백업, root + systemd일 때) → ⑥ ./start.sh(기동·승계)
# 다시 실행해도 된다: .env·DB 볼륨·등록된 서비스는 그대로 두고 빠진 것만 채운다.
#
# 옵션:
#   --port N               앱 포트(기본 7340, .env를 새로 만들 때만 반영)
#   --db-port N            DB 호스트 포트(기본 7341, 같은 조건)
#   --migrate ask|yes|no   승계(초기 데이터) 실행 여부 — start.sh로 넘긴다(기본 ask)
#   --migrate-all          승계를 1~12 한 번에(start.sh --migrate-all)
#   --no-systemd           systemd 서비스·타이머를 등록하지 않는다
#   --no-start             설치(①~⑤)만 하고 기동하지 않는다
#   --write-units 폴더     systemd 단위 파일을 그 폴더에 쓰기만 하고 끝낸다(검토·검증용)
#
# 예: sudo ./install.sh --migrate yes --migrate-all
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE=(docker compose --project-directory "$ROOT" -f "$ROOT/docker-compose.yml")
APP_PORT=7340
DB_PORT=7341
START_ARGS=()
USE_SYSTEMD=1
DO_START=1
UNITS_DIR=''
SERVICE=termflow

if [ -t 1 ]; then C_STEP=$'\e[36m' C_OK=$'\e[32m' C_WARN=$'\e[33m' C_ERR=$'\e[31m' C_END=$'\e[0m'; else C_STEP='' C_OK='' C_WARN='' C_ERR='' C_END=''; fi
step() { printf '\n%s[install] %s%s\n' "$C_STEP" "$1" "$C_END"; }
ok() { printf '%s  - %s%s\n' "$C_OK" "$1" "$C_END"; }
info() { printf '  - %s\n' "$1"; }
warn() { printf '%s  - %s%s\n' "$C_WARN" "$1" "$C_END"; }
die() {
  printf '\n' >&2
  local l
  for l in "$@"; do printf '%s[install] %s%s\n' "$C_ERR" "$l" "$C_END" >&2; done
  exit 1
}
is_port() { case "$1" in '' | *[!0-9]*) return 1 ;; *) [ "$1" -ge 1 ] && [ "$1" -le 65535 ] ;; esac; }

while [ $# -gt 0 ]; do
  case "$1" in
    --port) [ $# -ge 2 ] || die '--port 다음에 번호를 쓰세요.' && APP_PORT="$2" && shift 2 ;;
    --port=*) APP_PORT="${1#*=}" && shift ;;
    --db-port) [ $# -ge 2 ] || die '--db-port 다음에 번호를 쓰세요.' && DB_PORT="$2" && shift 2 ;;
    --db-port=*) DB_PORT="${1#*=}" && shift ;;
    --migrate) [ $# -ge 2 ] || die '--migrate 다음에 ask|yes|no 를 쓰세요.' && START_ARGS+=(--migrate "$2") && shift 2 ;;
    --migrate=*) START_ARGS+=("$1") && shift ;;
    --migrate-all) START_ARGS+=(--migrate-all) && shift ;;
    --no-systemd) USE_SYSTEMD=0 && shift ;;
    --no-start) DO_START=0 && shift ;;
    --write-units) [ $# -ge 2 ] || die '--write-units 다음에 폴더를 쓰세요.' && UNITS_DIR="$2" && shift 2 ;;
    -h | --help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' && exit 0 ;;
    *) die "알 수 없는 옵션: $1 (도움말: ./install.sh --help)" ;;
  esac
done
is_port "$APP_PORT" || die "--port 가 올바르지 않습니다: $APP_PORT"
is_port "$DB_PORT" || die "--db-port 가 올바르지 않습니다: $DB_PORT"

# ---------- systemd 단위(부팅 시 기동 · 매일 백업) ----------
DOCKER_BIN="$(command -v docker || echo /usr/bin/docker)"
write_units() {
  local dir="$1"
  mkdir -p "$dir"
  cat >"$dir/$SERVICE.service" <<EOF
# TermFlow — docker compose 기동/중지(install.sh가 만든다, CR-12 C9). 폴더를 옮기면 install.sh를 다시 실행한다.
# 안내: $ROOT/docs/설치_운영_가이드.md §14
[Unit]
Description=TermFlow (docker compose: db + app)
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$ROOT
ExecStart=$DOCKER_BIN compose --project-directory $ROOT -f $ROOT/docker-compose.yml up -d --wait
ExecStop=$DOCKER_BIN compose --project-directory $ROOT -f $ROOT/docker-compose.yml stop
TimeoutStartSec=600

[Install]
WantedBy=multi-user.target
EOF
  cat >"$dir/$SERVICE-backup.service" <<EOF
# TermFlow DB 백업(pg_dump -Fc → $ROOT/backup, 14일 보관). termflow-backup.timer가 매일 부른다.
[Unit]
Description=TermFlow DB 백업
Requires=docker.service
After=docker.service $SERVICE.service

[Service]
Type=oneshot
WorkingDirectory=$ROOT
ExecStart=$ROOT/scripts/backup.sh
EOF
  cat >"$dir/$SERVICE-backup.timer" <<EOF
# TermFlow DB 백업 — 매일 02:00(꺼져 있어 놓친 회차는 켜질 때 한 번)
[Unit]
Description=TermFlow DB 백업 매일 02:00

[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
  chmod 644 "$dir/$SERVICE.service" "$dir/$SERVICE-backup.service" "$dir/$SERVICE-backup.timer"
}
if [ -n "$UNITS_DIR" ]; then
  write_units "$UNITS_DIR"
  echo "[install] systemd 단위 3개를 썼습니다: $UNITS_DIR"
  exit 0
fi

# ---------- ① 환경 ----------
step '① 환경 확인'
[ "$(uname -s)" = Linux ] || warn "Linux가 아닙니다($(uname -s)). Windows는 start.bat을 쓰세요. 계속 진행합니다."
command -v docker >/dev/null 2>&1 || die 'docker 명령이 없습니다. Docker Engine과 compose 플러그인을 먼저 설치하세요.' \
  '  예(Ubuntu·Debian): https://docs.docker.com/engine/install/ubuntu/  — 설치·운영 가이드 §14.1' \
  '  (폐쇄망은 배포판 패키지 docker.io + docker-compose-v2 또는 docker-ce 오프라인 .deb/.rpm)'
docker info >/dev/null 2>&1 || die 'Docker 데몬에 연결하지 못했습니다(docker info 실패).' \
  '  sudo systemctl enable --now docker  — root가 아니면 docker 그룹에 넣고 다시 로그인: sudo usermod -aG docker <사용자>'
docker compose version >/dev/null 2>&1 || die 'docker compose(v2) 플러그인이 없습니다(docker-compose-plugin 또는 docker-compose-v2 패키지).'
ok "Docker $(docker version -f '{{.Server.Version}}' 2>/dev/null) · $(docker compose version --short 2>/dev/null | sed 's/^/compose /')"
[ -f "$ROOT/docker-compose.yml" ] || die "docker-compose.yml이 없습니다: $ROOT (설치 폴더에서 실행하세요)"
[ -f "$ROOT/seed/original/dump-gen_table-new.sql" ] || warn '승계 원본(seed/original/dump-gen_table-new.sql)이 없습니다 — 승계(초기 데이터)는 실행할 수 없습니다.'
chmod +x "$ROOT/start.sh" "$ROOT"/scripts/*.sh 2>/dev/null

# ---------- ② 오프라인 이미지 ----------
step '② 이미지 적재(오프라인 번들)'
shopt -s nullglob
TARS=("$ROOT"/images/*.tar.gz "$ROOT"/images/*.tar)
shopt -u nullglob
if [ "${#TARS[@]}" -eq 0 ]; then
  info 'images/ 폴더에 이미지 파일이 없습니다 — 레지스트리에서 받거나 소스로 빌드합니다(인터넷 필요).'
else
  for t in "${TARS[@]}"; do
    info "docker load: $(basename "$t")"
    docker load -i "$t" | sed 's/^/    /' || die "이미지 적재 실패: $t"
  done
  ok "이미지 파일 ${#TARS[@]}개 적재"
fi

# ---------- ③ .env ----------
step '③ .env'
ENV_FILE="$ROOT/.env"
# 영문·숫자 난수 n자(/dev/urandom). 화면에 내지 않는다.
rand_alnum() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$1"; }
rand_hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
# KEY=값 줄을 바꾼다(없으면 끝에 더한다). 값에는 영문·숫자·'-'만 들어간다.
set_env() {
  local key="$1" val="$2"
  if grep -qE "^#?${key}=" "$ENV_FILE"; then
    sed -i -E "s|^#?${key}=.*$|${key}=${val}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >>"$ENV_FILE"
  fi
}
if [ -f "$ENV_FILE" ]; then
  ok '.env가 이미 있습니다 — 그대로 씁니다(비밀값을 바꾸지 않는다).'
else
  [ -f "$ROOT/.env.example" ] || die ".env.example이 없습니다: $ROOT"
  umask 077
  cp "$ROOT/.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  set_env NODE_ENV production
  set_env TERMFLOW_DB_PASSWORD "$(rand_alnum 32)"
  # 관리자 비밀번호 정책(8~64자, 2종 이상, 로그인 ID 미포함) — 영문·숫자 22자 + '-' + 숫자(CR-11 C3과 같은 형식)
  set_env TERMFLOW_ADMIN_PASSWORD "$(rand_alnum 22)-$((RANDOM % 10))"
  set_env TERMFLOW_SESSION_SECRET "$(rand_hex 32)"
  [ "$APP_PORT" != 7340 ] && set_env TERMFLOW_APP_PORT "$APP_PORT"
  [ "$DB_PORT" != 7341 ] && set_env TERMFLOW_DB_PORT "$DB_PORT"
  umask 022
  ok ".env 생성(권한 600): 비밀값 3개 난수, NODE_ENV=production$([ "$APP_PORT" != 7340 ] && printf ', 앱 포트 %s' "$APP_PORT")"
  info '초기 관리자 비밀번호는 화면에 내지 않습니다 — 첫 로그인 전에 확인: sudo grep ^TERMFLOW_ADMIN_PASSWORD= .env'
fi
# sudo로 설치했으면 .env를 실행 사용자 것으로 둔다(백업 타이머·start.sh는 root로 돈다)
if [ "$(id -u)" = 0 ] && [ -n "${SUDO_UID:-}" ]; then chown "$SUDO_UID:${SUDO_GID:-$SUDO_UID}" "$ENV_FILE" 2>/dev/null; fi

# ---------- ④ 이미지 확인 ----------
step '④ 이미지 확인'
IMAGES="$("${COMPOSE[@]}" config --images 2>/dev/null)" || die 'docker compose config 실패 — .env 형식을 확인하세요(주석은 별도 줄).'
MISSING=()
for img in $IMAGES; do
  if docker image inspect "$img" >/dev/null 2>&1; then ok "$img"; else MISSING+=("$img"); fi
done
for img in "${MISSING[@]}"; do
  case "$img" in
    termflow-app:*)
      if [ -f "$ROOT/Dockerfile" ] && [ -d "$ROOT/apps" ]; then
        warn "$img 없음 — 기동 때 소스로 빌드합니다(인터넷으로 node 이미지·npm 패키지를 받습니다, 3~10분)."
      else
        die "$img 이미지가 없고 빌드할 소스도 없습니다." '  오프라인 번들(termflow-linux-<판>.tar.gz)의 images/ 폴더를 함께 풀었는지 확인하세요.'
      fi
      ;;
    *) warn "$img 없음 — 기동 때 레지스트리에서 받습니다(인터넷 필요)." ;;
  esac
done

# ---------- ⑤ systemd ----------
step '⑤ 부팅 시 기동·매일 백업(systemd)'
if [ "$USE_SYSTEMD" = 0 ]; then
  info '--no-systemd: 등록하지 않습니다.'
elif [ "$(id -u)" != 0 ]; then
  info 'root가 아니라 등록하지 않습니다(sudo ./install.sh 로 다시 실행하면 등록). cron 예:'
  info "  0 2 * * * $ROOT/scripts/backup.sh >> $ROOT/logs/backup.log 2>&1"
elif ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
  info 'systemd가 없는 환경입니다 — 등록하지 않습니다. compose의 restart: unless-stopped로 Docker가 켜질 때 함께 뜹니다.'
  info "  백업은 cron으로: 0 2 * * * $ROOT/scripts/backup.sh >> $ROOT/logs/backup.log 2>&1"
else
  write_units /etc/systemd/system
  systemctl daemon-reload
  systemctl enable "$SERVICE.service" >/dev/null 2>&1 && ok "$SERVICE.service 등록(부팅 시 기동)"
  systemctl enable --now "$SERVICE-backup.timer" >/dev/null 2>&1 && ok "$SERVICE-backup.timer 등록(매일 02:00 백업 → $ROOT/backup)"
  systemctl enable docker.service >/dev/null 2>&1 || true
fi

# ---------- ⑥ 기동 ----------
if [ "$DO_START" = 0 ]; then
  step '⑥ 기동 생략(--no-start) — 나중에 ./start.sh'
  exit 0
fi
step '⑥ 기동(./start.sh)'
"$ROOT/start.sh" "${START_ARGS[@]+"${START_ARGS[@]}"}" || exit $?
if [ "$USE_SYSTEMD" = 1 ] && [ "$(id -u)" = 0 ] && [ -d /run/systemd/system ]; then
  # 이미 compose로 떠 있으니 상태만 맞춘다(재부팅 뒤부터 systemd가 올린다)
  systemctl start "$SERVICE.service" >/dev/null 2>&1 || true
fi
step '설치 완료'
info "초기 관리자: $(grep -E '^TERMFLOW_ADMIN_LOGIN=' "$ENV_FILE" | cut -d= -f2- | sed 's/^$/admin/') — 비밀번호는 .env의 TERMFLOW_ADMIN_PASSWORD(첫 로그인 때 바꾸게 된다)"
info "백업: scripts/backup.sh · 복구: scripts/restore.sh <파일> · 업그레이드: 설치·운영 가이드 §14.5"
exit 0
