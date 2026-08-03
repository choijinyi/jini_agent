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
  [string]$Dir = (Join-Path $env:LOCALAPPDATA 'jini-agent'),
  [switch]$SkipCliInstall
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

# 2-1. 프로바이더 CLI 자동 설치 — 없는 것만 설치한다(이미 있으면 건드리지 않는다)
if (-not $SkipCliInstall) {
  $clis = @(
    @{ id = 'claude'; bin = 'claude'; pkg = '@anthropic-ai/claude-code' },
    @{ id = 'gemini'; bin = 'gemini'; pkg = '@google/gemini-cli' },
    @{ id = 'codex'; bin = 'codex'; pkg = '@openai/codex' }
  )
  foreach ($c in $clis) {
    if (Get-Command $c.bin -ErrorAction SilentlyContinue) {
      Info "$($c.id) 이미 설치됨"
      continue
    }
    Info "$($c.id) 설치 중 — npm install -g $($c.pkg)"
    npm install -g $c.pkg --no-audit --no-fund | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Warn "$($c.id) 설치 실패 — 나중에 직접 실행: npm install -g $($c.pkg)"
    } else {
      Info "$($c.id) 설치 완료"
    }
  }
} else {
  Info 'CLI 자동 설치 건너뜀(-SkipCliInstall)'
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

    # 아이콘: 저장소의 assets/jini.ico. 없고 바탕화면에 jini.png 가 있으면 즉석 변환한다.
    $ico = Join-Path $Dir 'assets\jini.ico'
    if (-not (Test-Path $ico)) {
      $png = Join-Path ([Environment]::GetFolderPath('Desktop')) 'jini.png'
      $maker = Join-Path $Dir 'tools\make-icon.ps1'
      if ((Test-Path $png) -and (Test-Path $maker)) {
        Push-Location $Dir
        try { & powershell -NoProfile -ExecutionPolicy Bypass -File $maker -Png $png -Ico 'assets\jini.ico' | Out-Null } finally { Pop-Location }
      }
    }
    if (Test-Path $ico) { $lnk.IconLocation = "$ico,0" }

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

# 6. 스킬 확인 — skills/ 는 저장소에 함께 추적되므로 clone 만으로 이미 배치돼 있다.
#    여기서 네트워크로 다시 받지 않는다. 받는 것이 아니라 **맞는지 확인**하는 단계다.
#    스킬이 없거나 어긋나도 설치를 중단하지 않는다 — 에이전트는 스킬 없이도 동작한다.
#    마지막에 두는 이유: 개수 고지와 잔여 위험 문장이 설치자가 마지막으로 읽는 줄이 되게 하려는 것이다.
Write-Host ''
Push-Location $Dir
try {
  node src/tools/skills-verify.js
  if ($LASTEXITCODE -ne 0) {
    Warn '스킬 정합에 어긋난 항목이 있습니다(설치는 계속됩니다). 위 FAIL 줄을 확인하세요.'
  }
} finally { Pop-Location }

# 스킬 확인 결과는 설치 성공 여부를 바꾸지 않는다 — 그것을 종료 코드로 못박는다.
# setup.ps1 은 이 스크립트의 종료 코드를 그대로 "설치 실패" 판정에 쓴다
# (setup.ps1: `if ($LASTEXITCODE -ne 0) { ... }`). 실측해 보면 현재 형태에서는
# 명시적 exit 없이도 0 이 나온다(`powershell -File` 은 스크립트가 직접 exit 하지 않으면 0 을 돌려주며,
# 마지막 네이티브 명령이 실패해도 그렇다 — 대조군 `exit 3`/`throw` 로 비0 감지 가능함을 확인).
# 그래도 명시해 두는 이유는 이 블록이 파일 맨 끝이라, 나중에 try/finally 를 걷어내거나
# 줄을 덧붙이는 편집 한 번으로 그 성질이 조용히 바뀔 수 있기 때문이다.
exit 0
