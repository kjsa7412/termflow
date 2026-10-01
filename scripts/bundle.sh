#!/usr/bin/env bash
# TermFlow Linux 오프라인 번들(T12.4, CR-12 C7): 인터넷 없는 Linux 서버에 들고 가는 파일 한 개를 만든다.
#
#   release/termflow-linux-<판>.tar.gz
#     termflow-<판>/            git archive(<ref>) — compose·스크립트·seed·문서·소스(업그레이드 빌드용)
#     termflow-<판>/images/     termflow-images-<판>.tar.gz = docker save termflow-app:<판> postgres:17
#   release/termflow-linux-<판>.tar.gz.sha256
#
# 판은 docker-compose.yml의 app 이미지 태그(termflow-app:<판>)에서 읽는다. 이미지가 이 PC에 있어야 한다
# (없으면 --build로 먼저 만든다). Windows에서는 Git Bash로 실행한다.
#
# 옵션: --ref <git ref>(기본 HEAD) · --build(docker build 먼저) · --no-images(소스만) · --out 폴더(기본 release)
# 서버에서(설치·업그레이드 같음 — .env·backup·logs는 번들에 없어 그대로 남는다):
#   sudo mkdir -p /opt/termflow && sudo tar -xzf termflow-linux-<판>.tar.gz -C /opt/termflow --strip-components=1 && sudo /opt/termflow/install.sh
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF=HEAD
BUILD=0
IMAGES=1
OUT="$ROOT/release"

die() {
  printf '[bundle] %s\n' "$1" >&2
  exit 1
}
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) [ $# -ge 2 ] || die '--ref 다음에 git ref를 쓰세요.' && REF="$2" && shift 2 ;;
    --build) BUILD=1 && shift ;;
    --no-images) IMAGES=0 && shift ;;
    --out) [ $# -ge 2 ] || die '--out 다음에 폴더를 쓰세요.' && OUT="$2" && shift 2 ;;
    -h | --help) sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' && exit 0 ;;
    *) die "알 수 없는 옵션: $1" ;;
  esac
done

git -C "$ROOT" rev-parse --verify -q "$REF^{commit}" >/dev/null || die "git ref가 없습니다: $REF"
APP_IMAGE="$(git -C "$ROOT" show "$REF:docker-compose.yml" | sed -nE 's/^[[:space:]]*image:[[:space:]]*(termflow-app:[^[:space:]]+).*/\1/p' | head -n1)"
[ -n "$APP_IMAGE" ] || die "docker-compose.yml($REF)에서 termflow-app 이미지 태그를 찾지 못했습니다."
VER="${APP_IMAGE#termflow-app:}"
DB_IMAGE="$(git -C "$ROOT" show "$REF:docker-compose.yml" | sed -nE 's/^[[:space:]]*image:[[:space:]]*(postgres:[^[:space:]]+).*/\1/p' | head -n1)"
DB_IMAGE="${DB_IMAGE:-postgres:17}"
NAME="termflow-$VER"
echo "[bundle] 판 $VER (ref $REF = $(git -C "$ROOT" rev-parse --short "$REF")) · 이미지 $APP_IMAGE, $DB_IMAGE"
[ -z "$(git -C "$ROOT" status --porcelain)" ] || echo '[bundle] 주의: 커밋하지 않은 변경은 번들에 들어가지 않습니다(git archive).'

if [ "$IMAGES" = 1 ]; then
  docker info >/dev/null 2>&1 || die 'Docker가 실행 중이 아닙니다.'
  if [ "$BUILD" = 1 ]; then
    echo "[bundle] docker build -t $APP_IMAGE (현재 작업 폴더 기준)"
    docker build -t "$APP_IMAGE" "$ROOT" || die 'docker build 실패'
  fi
  docker image inspect "$APP_IMAGE" >/dev/null 2>&1 || die "$APP_IMAGE 이미지가 없습니다. --build 를 붙이거나 docker compose build app 후 다시 실행하세요."
  docker image inspect "$DB_IMAGE" >/dev/null 2>&1 || docker pull "$DB_IMAGE" || die "$DB_IMAGE 이미지를 받지 못했습니다."
fi

WORK="$ROOT/migration/work/bundle"
rm -rf "$WORK"
mkdir -p "$WORK" "$OUT"
echo "[bundle] git archive → $NAME/"
git -C "$ROOT" archive --format=tar --prefix="$NAME/" "$REF" | tar -x -C "$WORK" || die 'git archive 실패'
if [ "$IMAGES" = 1 ]; then
  mkdir -p "$WORK/$NAME/images"
  echo "[bundle] docker save $APP_IMAGE $DB_IMAGE | gzip (수 분)"
  docker save "$APP_IMAGE" "$DB_IMAGE" | gzip -6 >"$WORK/$NAME/images/termflow-images-$VER.tar.gz" || die 'docker save 실패'
fi

TARGET="$OUT/termflow-linux-$VER.tar.gz"
[ "$IMAGES" = 1 ] || TARGET="$OUT/termflow-linux-$VER-src.tar.gz"
echo "[bundle] 묶기 → $TARGET"
tar -czf "$TARGET" -C "$WORK" "$NAME" || die '묶기 실패'
rm -rf "$WORK"
(cd "$OUT" && sha256sum "$(basename "$TARGET")" >"$(basename "$TARGET").sha256")
SIZE="$(wc -c <"$TARGET" | tr -d '[:space:]')"
echo "[bundle] 완료: $TARGET ($((SIZE / 1024 / 1024)) MB) · $(cut -c1-16 <"$TARGET.sha256")…"
echo "[bundle] 서버: sudo mkdir -p /opt/termflow && sudo tar -xzf $(basename "$TARGET") -C /opt/termflow --strip-components=1 && sudo /opt/termflow/install.sh"
