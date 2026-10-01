#!/usr/bin/env bash
# TermFlow DB 백업(Linux, backup.ps1 이식 — 설계서 §12.4, T12.2): pg_dump -Fc → backup/termflow_yyyyMMdd.dump, 14일 초과 파일 삭제.
#
# 실행 중인 compose db 서비스 안에서 pg_dump -Fc로 덤프를 만들고 pg_restore -l로 목차를 읽어 검증한 뒤
# 호스트 backup 폴더로 복사한다(docker compose cp). 같은 날 파일이 이미 있으면 덮어쓰지 않고
# termflow_yyyyMMdd_HHmmss.dump로 만든다. 보관 기간이 지난 termflow_*.dump만 지운다.
#
# 옵션: --out-dir 폴더(기본: 설치 폴더/backup) · --keep-days 일수(기본 14, 0이면 삭제 안 함)
# 매일 자동 실행: install.sh가 systemd 타이머(termflow-backup.timer)를 등록한다. cron이면
#   0 2 * * * /opt/termflow/scripts/backup.sh >> /opt/termflow/logs/backup.log 2>&1
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose --project-directory "$ROOT" -f "$ROOT/docker-compose.yml")
TMP_IN_CONTAINER=/tmp/termflow_backup.dump
OUT_DIR="$ROOT/backup"
KEEP_DAYS=14

die() {
  printf '[backup] %s\n' "$1" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --out-dir) [ $# -ge 2 ] || die '--out-dir 다음에 폴더를 쓰세요.' && OUT_DIR="$2" && shift 2 ;;
    --out-dir=*) OUT_DIR="${1#*=}" && shift ;;
    --keep-days) [ $# -ge 2 ] || die '--keep-days 다음에 일수를 쓰세요.' && KEEP_DAYS="$2" && shift 2 ;;
    --keep-days=*) KEEP_DAYS="${1#*=}" && shift ;;
    -h | --help) sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' && exit 0 ;;
    *) die "알 수 없는 옵션: $1" ;;
  esac
done
case "$KEEP_DAYS" in '' | *[!0-9]*) die "--keep-days 는 0~3650 정수입니다: $KEEP_DAYS" ;; esac
[ "$KEEP_DAYS" -le 3650 ] || die "--keep-days 는 0~3650 정수입니다: $KEEP_DAYS"

docker info >/dev/null 2>&1 || die 'Docker가 실행 중이 아니거나 권한이 없습니다(sudo systemctl start docker, docker 그룹).'
[ -n "$("${COMPOSE[@]}" ps -q db 2>/dev/null)" ] || die 'db 서비스가 실행 중이 아닙니다(./start.sh 또는 docker compose up -d db).'

mkdir -p "$OUT_DIR"
TARGET="$OUT_DIR/termflow_$(date +%Y%m%d).dump"
[ -e "$TARGET" ] && TARGET="$OUT_DIR/termflow_$(date +%Y%m%d_%H%M%S).dump"

echo '[backup] pg_dump -Fc (db 서비스, DB termflow)'
"${COMPOSE[@]}" exec -T db pg_dump -U termflow -d termflow -Fc -f "$TMP_IN_CONTAINER" || die 'pg_dump 실패'

# 덤프 목차를 읽을 수 있어야 복구 가능한 파일로 본다
if ! TOC="$("${COMPOSE[@]}" exec -T db pg_restore -l "$TMP_IN_CONTAINER" 2>/dev/null)" || [ -z "$TOC" ]; then
  "${COMPOSE[@]}" exec -T db rm -f "$TMP_IN_CONTAINER" >/dev/null 2>&1
  die 'pg_restore -l 검증 실패(덤프 손상)'
fi
TABLE_DATA="$(printf '%s\n' "$TOC" | grep -c ' TABLE DATA ')"

"${COMPOSE[@]}" cp "db:$TMP_IN_CONTAINER" "$TARGET"
CP_EXIT=$?
"${COMPOSE[@]}" exec -T db rm -f "$TMP_IN_CONTAINER" >/dev/null 2>&1
{ [ "$CP_EXIT" = 0 ] && [ -f "$TARGET" ]; } || die "호스트로 복사 실패: $TARGET"
chmod 600 "$TARGET" 2>/dev/null

SIZE="$(wc -c <"$TARGET" | tr -d '[:space:]')"
echo "[backup] 완료: $TARGET (${SIZE} bytes, TABLE DATA ${TABLE_DATA}개)"

if [ "$KEEP_DAYS" -gt 0 ]; then
  # 마지막 수정이 KEEP_DAYS×24시간보다 오래된 파일(backup.ps1의 "KeepDays일 전보다 오래된 파일"과 같은 기준)
  find "$OUT_DIR" -maxdepth 1 -type f -name 'termflow_*.dump' -mmin +$((KEEP_DAYS * 1440)) -print0 |
    while IFS= read -r -d '' f; do
      rm -f -- "$f" && echo "[backup] 보관 기간(${KEEP_DAYS}일) 초과 삭제: $(basename "$f")"
    done
fi
exit 0
