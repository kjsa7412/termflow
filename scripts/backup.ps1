<#
.SYNOPSIS
  TermFlow DB 백업(설계서 §12.4, T11.4): pg_dump -Fc → backup\termflow_yyyyMMdd.dump, 14일 초과 파일 삭제.

.DESCRIPTION
  실행 중인 compose db 서비스 안에서 pg_dump -Fc로 덤프를 만들고 pg_restore -l로 목차를 읽어 검증한 뒤
  호스트 backup 폴더로 복사한다(바이너리를 PowerShell 파이프로 옮기면 깨지므로 docker compose cp 사용).
  같은 날 파일이 이미 있으면 덮어쓰지 않고 termflow_yyyyMMdd_HHmmss.dump로 만든다(릴리스 전 수동 백업 보존).
  보관 기간이 지난 termflow_*.dump만 지운다(다른 파일은 건드리지 않는다).

  매일 자동 실행(작업 스케줄러, 관리자 권한 불필요):
    schtasks /Create /SC DAILY /ST 02:00 /TN "TermFlow Backup" /TR "powershell -NoProfile -ExecutionPolicy Bypass -File C:\경로\termflow\scripts\backup.ps1"

.PARAMETER OutDir
  백업 폴더(기본: 저장소 루트\backup).
.PARAMETER KeepDays
  보관 일수(기본 14). 0이면 삭제하지 않는다.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\backup.ps1
#>
[CmdletBinding()]
param(
  [string]$OutDir,
  [ValidateRange(0, 3650)]
  [int]$KeepDays = 14
)

$ErrorActionPreference = 'Continue'
Set-StrictMode -Version 2
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $Root 'backup' }
$ComposeArgs = @('compose', '--project-directory', $Root, '-f', (Join-Path $Root 'docker-compose.yml'))
$TmpInContainer = '/tmp/termflow_backup.dump'

function Stop-WithError([string]$Text) {
  Write-Host "[backup] $Text" -ForegroundColor Red
  exit 1
}

$null = & docker info 2>&1
if ($LASTEXITCODE -ne 0) { Stop-WithError 'Docker가 실행 중이 아닙니다. Docker Desktop을 실행한 뒤 다시 실행하세요.' }

$dbId = & docker @ComposeArgs ps -q db 2>$null
if ($LASTEXITCODE -ne 0 -or -not $dbId) { Stop-WithError 'db 서비스가 실행 중이 아닙니다(start.bat 또는 docker compose up -d db).' }

if (-not (Test-Path -LiteralPath $OutDir)) { $null = New-Item -ItemType Directory -Path $OutDir }
$stamp = Get-Date -Format 'yyyyMMdd'
$target = Join-Path $OutDir "termflow_$stamp.dump"
if (Test-Path -LiteralPath $target) { $target = Join-Path $OutDir ("termflow_{0}.dump" -f (Get-Date -Format 'yyyyMMdd_HHmmss')) }

Write-Host "[backup] pg_dump -Fc (db 서비스, DB termflow)"
& docker @ComposeArgs exec -T db pg_dump -U termflow -d termflow -Fc -f $TmpInContainer
if ($LASTEXITCODE -ne 0) { Stop-WithError 'pg_dump 실패' }

# 덤프 목차를 읽을 수 있어야 복구 가능한 파일로 본다
$toc = & docker @ComposeArgs exec -T db pg_restore -l $TmpInContainer 2>$null
if ($LASTEXITCODE -ne 0 -or -not $toc) {
  $null = & docker @ComposeArgs exec -T db rm -f $TmpInContainer 2>&1
  Stop-WithError 'pg_restore -l 검증 실패(덤프 손상)'
}
$tableData = @($toc | Where-Object { $_ -match ' TABLE DATA ' }).Count

& docker @ComposeArgs cp "db:$TmpInContainer" $target
$cpExit = $LASTEXITCODE
$null = & docker @ComposeArgs exec -T db rm -f $TmpInContainer 2>&1
if ($cpExit -ne 0 -or -not (Test-Path -LiteralPath $target)) { Stop-WithError "호스트로 복사 실패: $target" }

$size = (Get-Item -LiteralPath $target).Length
Write-Host ("[backup] 완료: {0} ({1:N0} bytes, TABLE DATA {2}개)" -f $target, $size, $tableData) -ForegroundColor Green

if ($KeepDays -gt 0) {
  $cutoff = (Get-Date).AddDays(-$KeepDays)
  $old = @(Get-ChildItem -LiteralPath $OutDir -Filter 'termflow_*.dump' -File | Where-Object { $_.LastWriteTime -lt $cutoff })
  foreach ($f in $old) {
    Remove-Item -LiteralPath $f.FullName
    Write-Host "[backup] 보관 기간(${KeepDays}일) 초과 삭제: $($f.Name)"
  }
}
exit 0
