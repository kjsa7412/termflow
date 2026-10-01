#!/usr/bin/env bash
# TermFlow DB 복구(Linux, restore.ps1 이식 — 설계서 §12.4, T12.2): backup.sh가 만든 pg_dump -Fc 파일을 compose db에 되살린다.
#
# 순서: app 중지 → db 기동·healthy 대기 → DB termflow 삭제·재생성 → pg_restore(--exit-on-error) → 건수 출력 → app 기동.
# 현재 DB 내용은 모두 덮어쓴다. 되돌릴 수 없으므로 실행 전에 backup.sh로 현재 상태를 한 번 더 백업해 두는 것을 권장한다.
# 새 서버·새 볼륨 복구: 설치 폴더·.env를 옮긴 뒤 이 스크립트를 실행하면 빈 볼륨에 db를 만들고 복구한다.
#
# 사용: scripts/restore.sh <덤프 파일> [--force] [--no-app-start] [--timeout 초]
#   --force        확인 질문 없이 진행(무인 실행·리허설용)
#   --no-app-start 복구 후 app을 기동하지 않는다
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose --project-directory "$ROOT" -f "$ROOT/docker-compose.yml")
TMP_IN_CONTAINER=/tmp/termflow_restore.dump
FILE=''
FORCE=0
NO_APP_START=0
TIMEOUT=180

die() {
  printf '[restore] %s\n' "$1" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 && shift ;;
    --no-app-start) NO_APP_START=1 && shift ;;
    --timeout) [ $# -ge 2 ] || die '--timeout 다음에 초를 쓰세요.' && TIMEOUT="$2" && shift 2 ;;
    --timeout=*) TIMEOUT="${1#*=}" && shift ;;
    -h | --help) sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' && exit 0 ;;
    -*) die "알 수 없는 옵션: $1" ;;
    *) [ -z "$FILE" ] || die "덤프 파일은 하나만: $1" && FILE="$1" && shift ;;
  esac
done
[ -n "$FILE" ] || die '복구할 덤프 파일을 지정하세요: scripts/restore.sh backup/termflow_yyyyMMdd.dump'
[ -f "$FILE" ] || die "덤프 파일이 없습니다: $FILE"
case "$TIMEOUT" in '' | *[!0-9]*) die "--timeout 은 10~1800 정수입니다: $TIMEOUT" ;; esac
FILE="$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")"

docker info >/dev/null 2>&1 || die 'Docker가 실행 중이 아니거나 권한이 없습니다(sudo systemctl start docker, docker 그룹).'

if [ "$FORCE" = 0 ]; then
  echo "[restore] $FILE 로 DB termflow를 덮어씁니다. 현재 데이터는 사라집니다."
  [ -t 0 ] || die '입력이 없는 실행입니다. 확인 없이 진행하려면 --force 를 붙이세요.'
  read -r -p '  계속하려면 RESTORE 를 입력하세요: ' ANSWER
  [ "$ANSWER" = RESTORE ] || {
    echo '[restore] 취소했습니다.'
    exit 1
  }
fi

echo '[restore] app 중지(연결 해제)'
"${COMPOSE[@]}" stop app >/dev/null 2>&1

echo '[restore] db 기동·healthy 대기'
"${COMPOSE[@]}" up -d db || die 'db 서비스를 시작하지 못했습니다.'
DEADLINE=$((SECONDS + TIMEOUT))
HEALTHY=0
while [ "$SECONDS" -lt "$DEADLINE" ]; do
  ID="$("${COMPOSE[@]}" ps -q db 2>/dev/null | head -n1)"
  if [ -n "$ID" ] && [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$ID" 2>/dev/null)" = healthy ]; then
    HEALTHY=1
    break
  fi
  sleep 2
done
[ "$HEALTHY" = 1 ] || die 'db가 healthy 상태가 되지 않았습니다(docker compose logs db).'

db() { "${COMPOSE[@]}" exec -T db "$@"; }

"${COMPOSE[@]}" cp "$FILE" "db:$TMP_IN_CONTAINER" || die '덤프를 db 컨테이너로 복사하지 못했습니다.'
db pg_restore -l "$TMP_IN_CONTAINER" >/dev/null || die 'pg_restore -l 실패(덤프 손상 또는 형식 불일치)'
echo '[restore] 덤프 목차 확인'

echo '[restore] DB termflow 삭제·재생성'
db dropdb -U termflow --if-exists --force termflow || die 'dropdb 실패'
db createdb -U termflow -O termflow termflow || die 'createdb 실패'

echo '[restore] pg_restore'
db pg_restore -U termflow -d termflow --no-owner --exit-on-error "$TMP_IN_CONTAINER"
RC=$?
db rm -f "$TMP_IN_CONTAINER" >/dev/null 2>&1
[ "$RC" = 0 ] || die "pg_restore 실패(종료 코드 $RC). DB가 비어 있거나 일부만 복구됐을 수 있습니다."

COUNTS="$(db psql -U termflow -d termflow -tAc "select 'users=' || (select count(*) from tf_user) || ' projects=' || (select count(*) from tf_project) || ' tables=' || (select count(*) from prj_table)" 2>/dev/null)"
echo "[restore] 복구 완료: $COUNTS"

if [ "$NO_APP_START" = 0 ]; then
  "${COMPOSE[@]}" up -d app || die 'app 기동 실패(docker compose logs app)'
  echo '[restore] app 기동 요청 완료(healthy까지 수십 초)'
fi
exit 0
