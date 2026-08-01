<#
.SYNOPSIS
  Jini Agent 설치 마법사 — 설치 소스를 자동 선택해 install.ps1 을 실행한다.

.DESCRIPTION
  1순위 GitHub 원격(main 브랜치가 실제로 존재할 때), 2순위 로컬 저장소 폴더.
  -Check 를 주면 설치하지 않고 어느 소스를 쓸지만 보여준다.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File setup.ps1
  powershell -ExecutionPolicy Bypass -File setup.ps1 -Check
#>
[CmdletBinding()]
param(
  [switch]$Check,
  [string]$Remote = 'https://github.com/choijinyi/jini_agent.git',
  [string]$Local = (Join-Path $env:USERPROFILE 'jini-agent'),
  [string]$Raw = 'https://raw.githubusercontent.com/choijinyi/jini_agent/main/install.ps1'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Line($m, $c = 'Gray') { Write-Host "  $m" -ForegroundColor $c }
function Ok($m) { Line "[o] $m" 'Green' }
function Bad($m) { Line "[x] $m" 'Red' }

Write-Host ''
Write-Host '  Jini Agent 설치' -ForegroundColor Cyan
Write-Host '  다중 AI 코딩 에이전트 (claude / gemini / codex · 계정 로그인)' -ForegroundColor DarkGray
Write-Host ''

# 1. 전제 확인
$missing = @()
foreach ($c in 'node', 'git') {
  if (Get-Command $c -ErrorAction SilentlyContinue) { Ok $c } else { Bad "$c 없음"; $missing += $c }
}
if ($missing -contains 'node') { Line 'Node.js LTS 설치: https://nodejs.org' 'Yellow' }
if ($missing -contains 'git') { Line 'git 설치: https://git-scm.com/download/win' 'Yellow' }
if ($missing.Count) { Write-Host ''; throw '전제 조건이 갖춰지지 않았습니다.' }

$v = (node -v)
if ([int](($v -replace '^v', '').Split('.')[0]) -lt 20) { throw "Node.js 20 이상이 필요합니다 (현재 $v)." }
Ok "Node.js $v"

# 2. 설치 소스 선택 — 원격에 main 이 실제로 있는지로 판정한다(빈 저장소 오판 방지)
$src = $null
$srcName = $null
try {
  $refs = & git ls-remote $Remote 'refs/heads/main' 2>$null
  if ($LASTEXITCODE -eq 0 -and $refs) { $src = $Remote; $srcName = 'GitHub 원격' }
} catch { }

if (-not $src -and (Test-Path (Join-Path $Local 'package.json'))) {
  $src = $Local
  $srcName = '로컬 저장소'
}

if (-not $src) {
  Bad '설치 소스를 찾지 못했습니다.'
  Line "원격에 main 브랜치 없음: $Remote" 'Yellow'
  Line "로컬 저장소도 없음: $Local" 'Yellow'
  throw '설치 소스 부재'
}

Ok "설치 소스: $srcName"
Line $src 'DarkGray'
Write-Host ''

if ($Check) {
  Line '-Check 모드 — 설치하지 않고 종료합니다.' 'Yellow'
  return
}

# 3. 설치 스크립트 확보 (로컬 우선, 없으면 원격에서 내려받음)
$ps1 = Join-Path $Local 'install.ps1'
if (-not (Test-Path $ps1)) {
  $ps1 = Join-Path $env:TEMP 'jini-install.ps1'
  Line '설치 스크립트를 내려받는 중...' 'DarkGray'
  Invoke-WebRequest -UseBasicParsing $Raw -OutFile $ps1
}

# 4. 실행 — 자기검증을 통과해야 실행 파일이 만들어진다
Line '설치를 시작합니다.' 'DarkGray'
Write-Host ''
& powershell -NoProfile -ExecutionPolicy Bypass -File $ps1 -Repo $src
if ($LASTEXITCODE -ne 0) { throw "설치 실패 (exit $LASTEXITCODE)" }

Write-Host ''
Write-Host '  설치 완료' -ForegroundColor Green
Line '새 터미널을 열고 다음을 실행하세요:' 'Gray'
Line '  jini doctor    계정 로그인 상태 확인' 'Cyan'
Line '  jini           대화 시작' 'Cyan'
Line 'claude / gemini / codex 중 로그인이 안 된 CLI 는 한 번 직접 실행하면 됩니다.' 'DarkGray'
