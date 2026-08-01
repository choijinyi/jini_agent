<#
.SYNOPSIS
  Jini Agent 설치 (Windows)

.EXAMPLE
  # 원격 1줄 설치
  irm https://raw.githubusercontent.com/choijinyi/jini_agent/main/install.ps1 | iex

.EXAMPLE
  # 저장소를 지정해 설치
  .\install.ps1 -Repo https://github.com/choijinyi/jini_agent.git
#>
[CmdletBinding()]
param(
  [string]$Repo = $(if ($env:JINI_REPO) { $env:JINI_REPO } else { 'https://github.com/choijinyi/jini_agent.git' }),
  [string]$Ref = 'main',
  [string]$Dir = (Join-Path $env:LOCALAPPDATA 'jini-agent')
)

$ErrorActionPreference = 'Stop'

function Info($m) { Write-Host "[jini] $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "[jini] $m" -ForegroundColor Yellow }

# 1. 전제 확인
foreach ($cmd in @('git', 'node', 'npm')) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "$cmd 이(가) PATH 에 없습니다. Node.js 20+ 와 git 을 먼저 설치하세요."
  }
}
$nodeMajor = [int]((node -v).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) { throw "Node.js 20 이상이 필요합니다 (현재 $(node -v))." }

# 2. 클론 또는 갱신
if (Test-Path (Join-Path $Dir '.git')) {
  Info "기존 설치 갱신: $Dir"
  git -C $Dir fetch --depth 1 origin $Ref
  git -C $Dir reset --hard "origin/$Ref"
} else {
  Info "클론: $Repo -> $Dir"
  if (Test-Path $Dir) { Remove-Item $Dir -Recurse -Force }
  git clone --depth 1 --branch $Ref $Repo $Dir
}

# 3. 의존성
Info '의존성 설치'
Push-Location $Dir
try {
  npm install --omit=dev --no-audit --no-fund | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "npm install 실패 (exit $LASTEXITCODE)" }

  # Electron 바이너리는 postinstall 로 받는데 환경에 따라 이 단계가 조용히 건너뛰어진다
  # (2026-08-01 실측: 패키지는 있고 dist/electron.exe 만 없음). 직접 확인·복구한다.
  $exe = Join-Path $Dir 'node_modules\electron\dist\electron.exe'
  $inst = Join-Path $Dir 'node_modules\electron\install.js'
  if ((Test-Path $inst) -and -not (Test-Path $exe)) {
    Info 'Electron 바이너리 내려받는 중 (최초 1회)'
    node $inst
    if (-not (Test-Path $exe)) { Warn 'Electron 바이너리 확보 실패 — 창 앱 없이 CLI 만 설치됩니다.' }
  }
} finally { Pop-Location }

# 4. 자기검증 — 통과해야 실행 셈을 만든다(검증 실패 시 깨진 설치가 실행되는 것을 막는다)
Info '자기검증 실행'
Push-Location $Dir
try {
  node src/selftest.js
  if ($LASTEXITCODE -ne 0) {
    Warn '자기검증 실패 — 실행 셈을 만들지 않고 중단한다.'
    Warn "받아둔 소스는 $Dir 에 남아 있다(수동 점검용). 제거: Remove-Item -Recurse -Force '$Dir'"
    exit 1
  }
} finally { Pop-Location }

# 5. 실행 셈(shim) 생성 + PATH 등록
$shimDir = Join-Path $Dir 'shim'
New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
$entry = Join-Path $Dir 'bin\jini.js'
Set-Content -Path (Join-Path $shimDir 'jini.cmd') -Encoding ascii -Value @"
@echo off
node "$entry" %*
"@

# 5-1. 바탕화면 앱 바로가기 — Electron 창을 콘솔 없이 띄운다
$electron = Join-Path $Dir 'node_modules\electron\dist\electron.exe'
if (Test-Path $electron) {
  try {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $ws = New-Object -ComObject WScript.Shell
    $lnk = $ws.CreateShortcut((Join-Path $desktop 'Jini Agent.lnk'))
    $lnk.TargetPath = $electron
    $lnk.Arguments = "`"$(Join-Path $Dir 'app')`""
    $lnk.WorkingDirectory = $env:USERPROFILE
    $lnk.Description = 'Jini Agent - 다중 AI 코딩 에이전트'
    $lnk.Save()
    Info '바탕화면 바로가기 생성: Jini Agent'
  } catch {
    Warn "바로가기 생성 실패(무시 가능): $($_.Exception.Message)"
  }
} else {
  Warn 'Electron 이 없어 창 앱 바로가기를 만들지 않았습니다(CLI 는 정상 동작).'
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$shimDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$shimDir", 'User')
  Warn "PATH 에 $shimDir 을 추가했습니다 — 새 터미널에서 적용됩니다."
}
$env:Path = "$env:Path;$shimDir"

Info "설치 완료: $Dir"
Info '창 앱: 바탕화면의 "Jini Agent" 아이콘을 더블클릭'
Info '터미널: jini (대화) · jini ui (창) · jini doctor (계정 로그인 진단)'
