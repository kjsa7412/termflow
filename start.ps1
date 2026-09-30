<#
.SYNOPSIS
  TermFlow 원클릭 실행(설계서 §12.6, T11.3). 더블클릭은 start.bat을 쓴다.

.DESCRIPTION
  순서: ① Docker 확인 → ② .env 존재·필수 변수 → ③ db 기동·healthy 대기
        → ④ 승계 실행 여부 질문(최초 1회) → ⑤ app 기동·healthy 대기 → ⑥ 브라우저 열기
  문제가 있으면 안내를 출력하고 종료 코드 1로 끝난다.

.PARAMETER Migrate
  ask(기본) = 승계가 아직이면 묻는다 · yes = 묻지 않고 실행 · no = 건너뛴다.
.PARAMETER Build
  app 이미지를 다시 빌드한다(업그레이드 시).
.PARAMETER NoBrowser
  마지막에 브라우저를 열지 않고 주소만 출력한다.
.PARAMETER TimeoutSec
  서비스별 healthy 대기 상한(초).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1 -Build -Migrate no
#>
[CmdletBinding()]
param(
  [ValidateSet('ask', 'yes', 'no')]
  [string]$Migrate = 'ask',
  [switch]$Build,
  [switch]$NoBrowser,
  [ValidateRange(10, 1800)]
  [int]$TimeoutSec = 300
)

# 네이티브 명령(docker)의 stderr가 PowerShell 5.1에서 오류 레코드로 바뀌어 중단되지 않도록 Continue로 두고
# 종료 코드($LASTEXITCODE)로 판정한다.
$ErrorActionPreference = 'Continue'
Set-StrictMode -Version 2
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = $PSScriptRoot
$ComposeArgs = @('compose', '--project-directory', $Root, '-f', (Join-Path $Root 'docker-compose.yml'))
$RequiredVars = @('TERMFLOW_DB_PASSWORD', 'TERMFLOW_ADMIN_PASSWORD', 'TERMFLOW_SESSION_SECRET')
$SessionSecretMinBytes = 32
$LegacyDump = Join-Path $Root 'seed\original\dump-gen_table-new.sql'
$ReportDir = Join-Path $Root 'migration\report'

function Write-Step([string]$Text) { Write-Host "`n[TermFlow] $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "  - $Text" -ForegroundColor Green }
function Write-Info([string]$Text) { Write-Host "  - $Text" }
function Stop-WithError([string[]]$Lines) {
  Write-Host ''
  foreach ($l in $Lines) { Write-Host "[TermFlow] $l" -ForegroundColor Red }
  exit 1
}

# 출력은 화면으로 보내고(함수 반환값에 섞이지 않게) 종료 코드만 돌려준다.
function Invoke-Compose([string[]]$Arguments) {
  & docker @ComposeArgs @Arguments | Out-Host
  return $LASTEXITCODE
}

# .env를 KEY=VALUE로 읽는다(주석·빈 줄 무시, 값 양끝 따옴표 제거). compose와 같은 해석만 흉내 낸다.
function Read-DotEnv([string]$Path) {
  $vars = @{}
  foreach ($raw in [System.IO.File]::ReadAllLines($Path, [System.Text.Encoding]::UTF8)) {
    $line = $raw.Trim()
    if ($line -eq '' -or $line.StartsWith('#')) { continue }
    $eq = $line.IndexOf('=')
    if ($eq -lt 1) { continue }
    $key = $line.Substring(0, $eq).Trim()
    if ($key.StartsWith('export ')) { $key = $key.Substring(7).Trim() }
    $val = $line.Substring($eq + 1).Trim()
    if ($val.Length -ge 2 -and (($val.StartsWith('"') -and $val.EndsWith('"')) -or ($val.StartsWith("'") -and $val.EndsWith("'")))) {
      $val = $val.Substring(1, $val.Length - 2)
    }
    $vars[$key] = $val
  }
  return $vars
}

function Get-ContainerId([string]$Service) {
  $id = & docker @ComposeArgs ps -q $Service 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $id) { return $null }
  return ($id | Select-Object -First 1).Trim()
}

# 컨테이너 healthcheck가 healthy가 될 때까지 기다린다. unhealthy·종료면 즉시 실패.
function Wait-Healthy([string]$Service) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $last = ''
  while ((Get-Date) -lt $deadline) {
    $id = Get-ContainerId $Service
    if ($id) {
      $state = (& docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' $id 2>$null)
      if ($state) { $state = $state.Trim() }
      if ($state -ne $last) { Write-Info "$Service 상태: $state"; $last = $state }
      if ($state -eq 'running/healthy') { return $true }
      if ($state -like 'running/unhealthy' -or $state -like 'exited/*' -or $state -like 'dead/*') { return $false }
    }
    Start-Sleep -Seconds 2
  }
  Write-Info "$Service 대기 시간 초과(${TimeoutSec}초)"
  return $false
}

# ---------- ① Docker 확인 ----------
Write-Step '① Docker 확인'
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Stop-WithError @(
    'docker 명령을 찾을 수 없습니다. Docker Desktop을 설치한 뒤 다시 실행하세요.',
    '  https://www.docker.com/products/docker-desktop/'
  )
}
$null = & docker info 2>&1
if ($LASTEXITCODE -ne 0) {
  Stop-WithError @(
    'Docker가 실행 중이 아닙니다(docker info 실패).',
    '  시작 메뉴에서 Docker Desktop을 실행하고, 작업 표시줄 고래 아이콘이 "Engine running"이 된 뒤 다시 실행하세요.'
  )
}
$null = & docker compose version 2>&1
if ($LASTEXITCODE -ne 0) {
  Stop-WithError @('docker compose(v2)를 쓸 수 없습니다. Docker Desktop을 최신 버전으로 업데이트하세요.')
}
Write-Ok 'Docker 데몬 응답'

# ---------- ② .env ----------
Write-Step '② .env 확인'
$envFile = Join-Path $Root '.env'
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
  Stop-WithError @(
    ".env 파일이 없습니다: $envFile",
    '  1) .env.example을 .env로 복사합니다:  copy .env.example .env',
    "  2) 다음 값을 채웁니다: $($RequiredVars -join ', ')",
    "     (TERMFLOW_SESSION_SECRET은 ${SessionSecretMinBytes}바이트 이상 난수)",
    '  3) start.bat(또는 start.ps1)을 다시 실행합니다.'
  )
}
$dotenv = Read-DotEnv $envFile
$problems = @()
foreach ($name in $RequiredVars) {
  $v = if ($dotenv.ContainsKey($name)) { $dotenv[$name] } else { '' }
  if ($v -eq '') { $problems += "  - $name : 값이 비어 있습니다"; continue }
}
# 값 자리에 주석이 들어간 경우(KEY=   # 설명) — compose가 "# 설명"을 값으로 읽는다(CR-11a C4)
foreach ($key in $dotenv.Keys) {
  if ($dotenv[$key].StartsWith('#')) { $problems += "  - $key : 값이 '#'로 시작합니다. 주석은 별도 줄에 쓰세요" }
}
$secret = if ($dotenv.ContainsKey('TERMFLOW_SESSION_SECRET')) { $dotenv['TERMFLOW_SESSION_SECRET'] } else { '' }
if ($secret -ne '' -and [System.Text.Encoding]::UTF8.GetByteCount($secret) -lt $SessionSecretMinBytes) {
  $problems += "  - TERMFLOW_SESSION_SECRET : ${SessionSecretMinBytes}바이트 이상이어야 합니다(현재 $([System.Text.Encoding]::UTF8.GetByteCount($secret))바이트)"
}
if ($problems.Count -gt 0) {
  Stop-WithError (@(".env 필수 값을 확인하세요: $envFile") + $problems + @(
      '  세션 키 만들기(64자, cmd·PowerShell 어디서나):',
      '    powershell -NoProfile -c "[guid]::NewGuid().ToString(''N'') + [guid]::NewGuid().ToString(''N'')"'
    ))
}
Write-Ok ".env 필수 변수 $($RequiredVars.Count)개 확인"

# 호스트 포트: 셸 환경 변수 > .env > 기본값(compose 변수 치환과 같은 우선순위)
$appPort = if ($env:TERMFLOW_APP_PORT) { $env:TERMFLOW_APP_PORT } elseif ($dotenv.ContainsKey('TERMFLOW_APP_PORT') -and $dotenv['TERMFLOW_APP_PORT']) { $dotenv['TERMFLOW_APP_PORT'] } else { '8080' }
$appUrl = "http://localhost:$appPort"

# bind mount 대상(없으면 Docker가 만들지만 미리 만들어 둔다)
foreach ($d in @('logs', 'migration\report', 'backup')) {
  $p = Join-Path $Root $d
  if (-not (Test-Path -LiteralPath $p)) { $null = New-Item -ItemType Directory -Path $p }
}

# ---------- ③ db ----------
Write-Step '③ DB 기동(db)'
if ((Invoke-Compose @('up', '-d', 'db')) -ne 0) {
  Stop-WithError @('db 서비스를 시작하지 못했습니다. 위 docker 메시지를 확인하세요(포트 충돌이면 .env의 TERMFLOW_DB_PORT).')
}
if (-not (Wait-Healthy 'db')) {
  $null = Invoke-Compose @('logs', '--tail', '40', 'db')
  Stop-WithError @('db가 healthy 상태가 되지 않았습니다. 위 로그를 확인하세요.')
}
Write-Ok 'db healthy'

# ---------- ④ 승계(최초 1회) ----------
Write-Step '④ 데이터 승계 확인'
# 승계 상태: STDV1(1차 결과)·RMS(2차 결과) 프로젝트 존재 여부. 스키마가 아직 없으면(최초) 빈 값.
$sql = "select coalesce(string_agg(project_key, ',' order by project_key), '') from tf_project where project_key in ('STDV1','RMS')"
$found = & docker @ComposeArgs exec -T db psql -U termflow -d termflow -tAc $sql 2>$null
$keys = if ($LASTEXITCODE -eq 0 -and $found) { (($found | Out-String).Trim() -split ',') } else { @() }
$plan = $null
if ($keys -notcontains 'STDV1') {
  $plan = @{
    Label = '1차 승계(LOAD_LEGACY..DEFAULT_COL + 대사) — 원본 dump → STDV1 표준 사전'
    Args  = @()
  }
} elseif ($keys -notcontains 'RMS') {
  $plan = @{
    Label = '2차 승계(COPY_TO_RMS..DDL_REGRESSION) — STDV1 정정 반영 후 RMS 생성·33 테이블·DDL 회귀'
    Args  = @('--steps=COPY_TO_RMS..DDL_REGRESSION')
  }
}
if (-not $plan) {
  Write-Ok '승계 완료 상태(STDV1·RMS 존재) — 건너뜀'
} else {
  Write-Info "미실행: $($plan.Label)"
  $run = $false
  if ($Migrate -eq 'yes') { $run = $true }
  elseif ($Migrate -eq 'ask') {
    if ([Console]::IsInputRedirected) {
      Write-Info '입력이 없는 실행이라 건너뜁니다(-Migrate yes로 실행 가능).'
    } else {
      $answer = Read-Host '  지금 실행할까요? (y/N)'
      $run = ($answer -match '^(y|yes|ㅛ)$')
    }
  }
  if (-not $run) {
    Write-Info '승계를 건너뜁니다. 나중에 다시 start.bat을 실행하면 다시 묻습니다.'
  } else {
    if (-not (Test-Path -LiteralPath $LegacyDump -PathType Leaf)) {
      Stop-WithError @("승계 원본이 없습니다: $LegacyDump")
    }
    $runArgs = @('run', '--rm')
    if ($Build) { $runArgs += '--build' }
    $runArgs += @('app', 'node', 'apps/server/dist/migration/seed.js') + $plan.Args
    Write-Info '승계 러너 실행(이미지가 없으면 먼저 빌드합니다. 수 분 걸릴 수 있습니다)'
    if ((Invoke-Compose $runArgs) -ne 0) {
      Stop-WithError @('승계 러너가 실패했습니다. 위 출력과 리포트를 확인하세요.', "  리포트: $ReportDir")
    }
    Write-Ok "승계 완료. 리포트: $ReportDir"
  }
}

# ---------- ⑤ app ----------
Write-Step '⑤ 앱 기동(app)'
$upArgs = @('up', '-d')
if ($Build) { $upArgs += '--build' }
$upArgs += 'app'
Write-Info '이미지가 없으면 처음 한 번 빌드합니다(수 분 걸릴 수 있습니다).'
if ((Invoke-Compose $upArgs) -ne 0) {
  Stop-WithError @('app 서비스를 시작하지 못했습니다. 위 docker 메시지를 확인하세요(포트 충돌이면 .env의 TERMFLOW_APP_PORT).')
}
if (-not (Wait-Healthy 'app')) {
  $null = Invoke-Compose @('logs', '--tail', '60', 'app')
  Stop-WithError @('app이 healthy 상태가 되지 않았습니다. 위 로그(환경 변수 검증·마이그레이션 오류)를 확인하세요.')
}
Write-Ok "app healthy ($appUrl/health)"

# ---------- ⑥ 브라우저 ----------
Write-Step "⑥ 접속: $appUrl"
if ($NoBrowser) {
  Write-Info '브라우저 열기 생략(-NoBrowser)'
} else {
  Start-Process $appUrl
  Write-Ok '브라우저를 열었습니다. 로그인 화면이 보이면 정상입니다.'
}
Write-Info '중지: docker compose stop   /   로그: docker compose logs -f app   /   백업: scripts\backup.ps1'
exit 0
