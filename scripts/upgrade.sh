#!/usr/bin/env bash
# TermFlow Linux 업그레이드(T12.10): 서버로 옮긴 오프라인 번들 한 파일로 업그레이드한다(설치·운영 가이드 §14.5).
#
#   scp termflow-linux-<판>.tar.gz* root@<서버>:/tmp/
#   ssh root@<서버>
#   sudo bash /opt/termflow/scripts/upgrade.sh /tmp/termflow-linux-<판>.tar.gz
#
# 순서: ① 번들 확인(같은 폴더에 .sha256이 있으면 검증, 안의 판 읽기) → ② 백업(db가 떠 있으면 scripts/backup.sh)
#       → ③ 설치 폴더(이 스크립트의 상위 폴더)에 풀기(.env·backup·logs·migration/report는 번들에 없어 그대로)
#       → ④ install.sh --migrate no(새 이미지 적재·app 재생성·마이그레이션 자동 적용)
# 옵션: --no-backup(백업 생략) · 그 밖의 옵션은 install.sh로 넘긴다(예 --no-systemd)
set -u

# 풀기 단계에서 이 파일 자신이 덮어써진다 — bash가 전체를 먼저 읽도록 함수 안에 두고 끝에서 부른다
main() {
  local root bundle='' backup=1 args=() top ver
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  while [ $# -gt 0 ]; do
    case "$1" in
      --no-backup) backup=0 && shift ;;
      -h | --help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' && return 0 ;;
      -*) args+=("$1") && shift ;;
      *) [ -z "$bundle" ] || { echo "[upgrade] 번들은 하나만: $1" >&2 && return 1; }; bundle="$1" && shift ;;
    esac
  done
  [ -n "$bundle" ] || { echo '[upgrade] 번들 파일을 지정하세요: scripts/upgrade.sh /tmp/termflow-linux-<판>.tar.gz' >&2 && return 1; }
  [ -f "$bundle" ] || { echo "[upgrade] 파일이 없습니다: $bundle" >&2 && return 1; }
  [ -f "$root/install.sh" ] || { echo "[upgrade] 설치 폴더가 아닙니다(install.sh 없음): $root — 처음 설치는 가이드 §14.2" >&2 && return 1; }

  # ① 번들 확인
  if [ -f "$bundle.sha256" ]; then
    (cd "$(dirname "$bundle")" && sha256sum -c "$(basename "$bundle").sha256") || { echo '[upgrade] 체크섬 불일치 — 파일을 다시 옮기세요.' >&2 && return 1; }
  else
    echo "[upgrade] 주의: $(basename "$bundle").sha256이 없어 체크섬을 건너뜁니다."
  fi
  top="$(tar -tzf "$bundle" 2>/dev/null | head -n1)" || true
  case "$top" in termflow-*/) ver="${top#termflow-}" && ver="${ver%/}" ;; *) echo "[upgrade] TermFlow 번들이 아닙니다: $bundle" >&2 && return 1 ;; esac
  tar -tzf "$bundle" | grep -q "^termflow-$ver/install.sh$" || { echo '[upgrade] 번들에 install.sh가 없습니다.' >&2 && return 1; }
  echo "[upgrade] 번들 판 $ver → 설치 폴더 $root"

  # ② 백업
  if [ "$backup" = 1 ] && docker compose --project-directory "$root" -f "$root/docker-compose.yml" ps -q db 2>/dev/null | grep -q .; then
    "$root/scripts/backup.sh" || { echo '[upgrade] 백업 실패 — 중단합니다(--no-backup으로 생략 가능).' >&2 && return 1; }
  fi

  # ③ 풀기 → ④ 설치(새 install.sh)
  # 이전 판 이미지 파일은 지운다(install.sh가 images/의 파일을 모두 적재한다)
  rm -f "$root"/images/termflow-images-*.tar.gz
  tar -xzf "$bundle" -C "$root" --strip-components=1 --no-same-owner || { echo '[upgrade] 풀기 실패' >&2 && return 1; }
  echo "[upgrade] 풀기 완료 — install.sh --migrate no ${args[*]+"${args[*]}"}"
  "$root/install.sh" --migrate no "${args[@]+"${args[@]}"}"
}
main "$@"
exit $?
