<#
.SYNOPSIS
  TermFlow DB 복구(설계서 §12.4, T11.4): backup.ps1이 만든 pg_dump -Fc 파일을 compose db에 되살린다.

.DESCRIPTION
  순서: app 중지 → db 기동·healthy 대기 → DB termflow 삭제·재생성 → pg_restore(--exit-on-error) → 건수 출력 → app 기동.
  현재 DB 내용은 모두 덮어쓴다. 되돌릴 수 없으므로 실행 전에 backup.ps1로 현재 상태를 한 번 더 백업해 두는 것을 권장한다.
  새 PC·새 볼륨 복구: 저장소·.env를 옮긴 뒤 이 스크립트를 실행하면 빈 볼륨에 db를 만들고 복구한다.

.PARAMETER File
  복구할 덤프 파일(예: backup\termflow_20260930.dump).
.PARAMETER Force
  확인 질문 없이 진행한다(무인 실행·리허설용).
.PARAMETER NoAppStart
  복구 후 app을 기동하지 않는다.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\restore.ps1 -File .\backup\termflow_20260930.dump
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$File,
  [switch]$Force,
  [switch]$NoAppStart,
  [ValidateRange(10, 1800)]
  [int]$TimeoutSec = 180
)

$ErrorActionPreference = 'Continue'
Set-StrictMode -Version 2
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Split-Path -Parent $PSScriptRoot
$ComposeArgs = @('compose', '--project-directory', $Root, '-f', (Join-Path $Root 'docker-compose.yml'))
$TmpInContainer = '/tmp/termflow_restore.dump'

function Stop-WithError([string]$Text) {
  Write-Host "[restore] $Text" -ForegroundColor Red
  exit 1
}
# 출력은 화면으로 보내고(함수 반환값에 섞이지 않게) 종료 코드만 돌려준다. -Quiet이면 출력을 버린다.
function Invoke-Db([string[]]$Arguments, [switch]$Quiet) {
  if ($Quiet) { & docker @ComposeArgs exec -T db @Arguments | Out-Null }
  else { & docker @ComposeArgs exec -T db @Arguments | Out-Host }
  return $LASTEXITCODE
}

if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { Stop-WithError "덤프 파일이 없습니다: $File" }
$File = (Resolve-Path -LiteralPath $File).Path

$null = & docker info 2>&1
if ($LASTEXITCODE -ne 0) { Stop-WithError 'Docker가 실행 중이 아닙니다. Docker Desktop을 실행한 뒤 다시 실행하세요.' }

if (-not $Force) {
  Write-Host "[restore] $File 로 DB termflow를 덮어씁니다. 현재 데이터는 사라집니다." -ForegroundColor Yellow
  $answer = Read-Host '  계속하려면 RESTORE 를 입력하세요'
  if ($answer -cne 'RESTORE') { Write-Host '[restore] 취소했습니다.'; exit 1 }
}

Write-Host '[restore] app 중지(연결 해제)'
& docker @ComposeArgs stop app 2>$null | Out-Null

Write-Host '[restore] db 기동·healthy 대기'
& docker @ComposeArgs up -d db
if ($LASTEXITCODE -ne 0) { Stop-WithError 'db 서비스를 시작하지 못했습니다.' }
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$healthy = $false
while ((Get-Date) -lt $deadline) {
  $id = & docker @ComposeArgs ps -q db 2>$null
  if ($id) {
    $h = & docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' ($id | Select-Object -First 1).Trim() 2>$null
    if ($h -and $h.Trim() -eq 'healthy') { $healthy = $true; break }
  }
  Start-Sleep -Seconds 2
}
if (-not $healthy) { Stop-WithError 'db가 healthy 상태가 되지 않았습니다(docker compose logs db).' }

& docker @ComposeArgs cp $File "db:$TmpInContainer"
if ($LASTEXITCODE -ne 0) { Stop-WithError '덤프를 db 컨테이너로 복사하지 못했습니다.' }
if ((Invoke-Db @('pg_restore', '-l', $TmpInContainer) -Quiet) -ne 0) { Stop-WithError 'pg_restore -l 실패(덤프 손상 또는 형식 불일치)' } else { Write-Host '[restore] 덤프 목차 확인' }

Write-Host '[restore] DB termflow 삭제·재생성'
if ((Invoke-Db @('dropdb', '-U', 'termflow', '--if-exists', '--force', 'termflow')) -ne 0) { Stop-WithError 'dropdb 실패' }
if ((Invoke-Db @('createdb', '-U', 'termflow', '-O', 'termflow', 'termflow')) -ne 0) { Stop-WithError 'createdb 실패' }

Write-Host '[restore] pg_restore'
$rc = Invoke-Db @('pg_restore', '-U', 'termflow', '-d', 'termflow', '--no-owner', '--exit-on-error', $TmpInContainer)
$null = Invoke-Db @('rm', '-f', $TmpInContainer)
if ($rc -ne 0) { Stop-WithError "pg_restore 실패(종료 코드 $rc). DB가 비어 있거나 일부만 복구됐을 수 있습니다." }

$sql = "select 'users=' || (select count(*) from tf_user) || ' projects=' || (select count(*) from tf_project) || ' tables=' || (select count(*) from prj_table)"
$counts = & docker @ComposeArgs exec -T db psql -U termflow -d termflow -tAc $sql 2>$null
Write-Host "[restore] 복구 완료: $(($counts | Out-String).Trim())" -ForegroundColor Green

if (-not $NoAppStart) {
  & docker @ComposeArgs up -d app
  if ($LASTEXITCODE -ne 0) { Stop-WithError 'app 기동 실패(docker compose logs app)' }
  Write-Host '[restore] app 기동 요청 완료(healthy까지 수십 초)'
}
exit 0
