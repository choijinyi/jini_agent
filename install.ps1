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
try { npm install --omit=dev --no-audit --no-fund | Out-Null } finally { Pop-Location }

# 4. 실행 셈(shim) 생성 + PATH 등록
$shimDir = Join-Path $Dir 'shim'
New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
$entry = Join-Path $Dir 'bin\jini.js'
Set-Content -Path (Join-Path $shimDir 'jini.cmd') -Encoding ascii -Value @"
@echo off
node "$entry" %*
"@

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$shimDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$shimDir", 'User')
  Warn "PATH 에 $shimDir 을 추가했습니다 — 새 터미널에서 적용됩니다."
}
$env:Path = "$env:Path;$shimDir"

# 5. 검증
Info '자기검증 실행'
Push-Location $Dir
try { node src/selftest.js } finally { Pop-Location }

Info "설치 완료: $Dir"
if (-not $env:ANTHROPIC_API_KEY) {
  Warn '다음 단계: $env:ANTHROPIC_API_KEY = "sk-ant-..." 를 설정하세요.'
  Warn '영속 설정: [Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY","sk-ant-...","User")'
}
Info '실행: jini'
