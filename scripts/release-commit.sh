#!/usr/bin/env bash
# TermFlow 배포물·태그를 달 커밋 고르기(CR-17 C8). 커밋 목록의 판 표시(태그)가 판을 올린 커밋에 붙게 한다.
#
#   판 올림 커밋 = <끝 커밋>까지의 이력에서 package.json "version"이 마지막으로 바뀐 커밋
#   - 판 올림 커밋 뒤의 변경이 제품과 무관한 문서뿐이면(docs — 설명서 두 권·그림 제외 —, 루트 .md, 개발 도구 폴더) 판 올림 커밋
#   - 뒤에 제품 파일이 바뀌었으면 <끝 커밋>(CI가 검사한 커밋)
#   - 판 올림 커밋을 이력에서 찾지 못하면(얕은 clone 범위 밖 등) <끝 커밋>
#
# 사용: scripts/release-commit.sh [끝 커밋, 기본 HEAD]   — 표준 출력 마지막 줄에 고른 커밋(전체 해시)
# 제외 경로 기준은 .github/workflows/ci.yml의 paths 필터와 같다.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
end="$(git -C "$ROOT" rev-parse "${1:-HEAD}")"

note() { printf '[release-commit] %s\n' "$1" >&2; }
pkgver() { sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([^"]+)".*/\1/p' | head -n1; }

ver="$(git -C "$ROOT" show "$end:package.json" | pkgver)"
bump="$(git -C "$ROOT" log -1 --format=%H -G '"version"' "$end" -- package.json)"
prev=""
if [ -n "$bump" ]; then
  prev="$(git -C "$ROOT" show "$bump^:package.json" 2>/dev/null | pkgver || true)"
fi

if [ -z "$bump" ] || [ -z "$prev" ] || [ "$prev" = "$ver" ]; then
  note "판 올림 커밋을 이력에서 찾지 못했습니다 — 끝 커밋 ${end:0:7}"
  echo "$end"
  exit 0
fi

changed="$(git -C "$ROOT" -c core.quotepath=off diff --name-only "$bump" "$end")"
product="$(printf '%s\n' "$changed" | grep -vE '^docs/|^[^/]+\.md$|^\.[cC]laude/|^$' || true)"
manual="$(printf '%s\n' "$changed" | grep -E '^docs/(사용자_가이드\.md|설치_운영_가이드\.md|img/)' || true)"

if [ -n "$product$manual" ]; then
  note "판 올림 커밋 ${bump:0:7} 뒤에 제품 파일이 바뀌었습니다 — 끝 커밋 ${end:0:7}:"
  printf '%s\n' "$product" "$manual" | sed '/^$/d; s/^/  /' >&2
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    echo "::warning::판 올림 커밋(${bump:0:7}) 뒤에 제품 파일이 바뀌어 끝 커밋(${end:0:7})에 태그를 답니다"
  fi
  echo "$end"
else
  note "판 올림 커밋 ${bump:0:7}($prev → $ver)"
  echo "$bump"
fi
