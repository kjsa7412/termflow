#!/usr/bin/env bash
# TermFlow 판 번호 확인(CR-14 C3·C11): 릴리스 전에 판을 올린 파일들이 서로 맞는지 본다.
#
#   package.json "version" = docker-compose.yml termflow-app:<판> = (태그를 주면) 태그 v<판>, docs/릴리스_노트_v<판>.md 있음
#
# 사용: scripts/release-check.sh [vX.Y.Z]   — 태그를 빼면 package.json의 판으로 확인한다
# 통과하면 표준 출력 마지막 줄에 태그(v<판>)를 쓴다. GitHub Actions 안이면 $GITHUB_OUTPUT에 tag·ver를 남긴다.
# 판을 올릴 때(로컬): package.json·docker-compose.yml·릴리스 노트를 고친 뒤 이 스크립트로 확인하고 main에 push한다.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then printf '::error::%s\n' "$1" >&2; else printf '[release-check] %s\n' "$1" >&2; fi
}

pkg="$(sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([^"]+)".*/\1/p' "$ROOT/package.json" | head -n1)"
img="$(sed -nE 's/^[[:space:]]*image:[[:space:]]*termflow-app:([^[:space:]]+).*/\1/p' "$ROOT/docker-compose.yml" | head -n1)"
tag="${1:-v$pkg}"

case "$tag" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *)
    fail "버전 태그 형식이 아닙니다: $tag (vX.Y.Z)"
    exit 1
    ;;
esac
ver="${tag#v}"
notes="docs/릴리스_노트_${tag}.md"

bad=0
[ "$pkg" = "$ver" ] || { fail "package.json version $pkg ≠ 판 $ver" && bad=1; }
[ "$img" = "$ver" ] || { fail "docker-compose.yml termflow-app:$img ≠ 판 $ver" && bad=1; }
[ -f "$ROOT/$notes" ] || { fail "릴리스 노트가 없습니다: $notes" && bad=1; }
[ "$bad" = 0 ] || exit 1

echo "[release-check] 판 $ver 일치(package.json · docker-compose.yml · $notes)"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "tag=$tag"
    echo "ver=$ver"
  } >>"$GITHUB_OUTPUT"
fi
echo "$tag"
