# Jini Agent

터미널에서 도는 코딩 에이전트. 기능은 일반적인 코딩 에이전트와 같되, **같은 작업을 더 적은 토큰으로** 끝내는 것을 설계 목표로 삼는다.

- **인증: 계정 로그인.** API 키를 쓰지 않는다. 이미 계정으로 로그인된 벤더 CLI를 헤드리스로 구동한다 — CYSJavis가 노드를 띄우는 방식과 같다.
- **다중 AI**: claude(마스터) · gemini · codex
- 런타임: Node.js 20+ · 의존성 1개(선택적 API 백엔드용) · 빌드 단계 없음
- 설치: git 저장소 + 설치 스크립트(`install.ps1` / `install.sh`)

| 프로바이더 | 역할 | 구동 명령(헤드리스) | 인증 |
|---|---|---|---|
| `claude` | 오케스트레이션·코딩·심층추론 (**마스터**) | `claude -p --output-format json` | Claude 계정 로그인 |
| `gemini` | 심층리서치·리뷰 | `gemini -p "" -o json --yolo` | Google 계정 로그인 |
| `codex` | 코드리뷰·구현 보조 | `codex exec - --json` | ChatGPT 계정 로그인 |

프롬프트는 **항상 stdin**으로 전달한다. argv에는 우리가 정한 플래그와 화이트리스트를 통과한 토큰(모델명·세션ID)만 들어가므로, 인용부호·개행·셸 메타문자로 명령이 깨지거나 주입되지 않는다.

## 설치

### 창 앱 (Electron)

설치가 끝나면 바탕화면에 **`Jini Agent`** 바로가기가 생긴다(콘솔 창 없이 뜬다).
터미널에서는 `jini ui` 로도 띄운다.

```
┌ 상단  프로바이더 상태 · 진단
├ 좌측  [작업 폴더] 폴더 열기 + 폴더 내용 목록
│       [계정]     프로바이더별 로그인 상태 + 로그인 버튼
│       [파이프라인] 배치별 단계 카드(대기/실행중/완료/실패), 동시 실행 배치 표시
├ 중앙  스트림 — 각 AI 산출물이 도착하는 대로, 마지막에 마스터 취합
└ 하단  입력창 + 토큰·비용 원장
```

**작업 폴더**: 좌측 [폴더 열기]로 고른 폴더가 이후 모든 작업의 기준이 된다.
폴더 내용이 바로 아래 표시되므로 무엇을 대상으로 일하는지 눈으로 확인할 수 있다.

**계정 — 각자 본인 계정으로 로그인한다.** 이 앱은 API 키를 배포하지 않는다.
설치한 사람이 자기 claude·gemini·codex 계정으로 로그인하고, 그 사용량은 본인 계정에 청구된다.

| 프로바이더 | 로그인 명령 | 상태 판정 근거 |
|---|---|---|
| claude | `claude auth login` | `~/.claude/.credentials.json` |
| gemini | `gemini` → `/auth` → Login with Google | `~/.gemini/google_accounts.json` + `settings.json` 의 `selectedType` |
| codex | `codex login` | `~/.codex/auth.json` |

좌측 [계정]의 **로그인** 버튼을 누르면 해당 명령이 터미널 창에서 열린다(대화형 인증은 사람이 마쳐야 한다).
로그인 후 상단 [진단]을 누르면 상태가 갱신된다. 홈 디렉터리 기준으로 판정하므로
**사용자마다 자기 로그인 상태가 따로 잡힌다**.

- 그냥 입력하면 **마스터 위임 파이프라인**이 돈다: claude가 작업을 쪼개고,
  의존성 없는 단계는 gemini·codex에 **병렬로** 나가며, 마스터가 결과를 취합한다.
- `@gemini 질문` 처럼 앞에 붙이면 파이프라인을 건너뛰고 그 AI에 직접 묻는다.

보안: `contextIsolation` 켜짐 · `nodeIntegration` 꺼짐 · CSP `self` 고정.
렌더러는 Node·파일시스템에 접근하지 못하고 preload가 노출한 함수만 쓴다.

### 바탕화면 설치 프로그램 (Windows · 더블클릭)

`desktop-launcher.bat` 를 바탕화면에 두고 더블클릭하면 끝난다. 런처는 순수 ASCII 배치
파일이고(콘솔 코드페이지에 따라 깨지지 않도록), 한글 UI와 실제 로직은 `setup.ps1` 이 맡는다.

```
Jini Agent 설치.bat  →  setup.ps1  →  install.ps1
                         │              └ 클론 → npm install → 자기검증 → 셈 생성 → PATH
                         └ 설치 소스 자동 선택: GitHub 원격(main 존재 시) → 없으면 로컬 저장소
```

`-Check` 를 붙여 실행하면 설치하지 않고 어느 소스를 쓸지만 확인한다.

### 명령줄 설치

```powershell
# Windows
irm https://raw.githubusercontent.com/choijinyi/jini_agent/main/install.ps1 | iex
[Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY","sk-ant-...","User")
```

```bash
# macOS / Linux / WSL
curl -fsSL https://raw.githubusercontent.com/choijinyi/jini_agent/main/install.sh | bash
export ANTHROPIC_API_KEY=sk-ant-...
```

설치 스크립트는 클론 → `npm install --omit=dev` → 실행 셈 생성 → PATH 등록 → 자기검증까지 수행한다. 재실행하면 갱신(`git reset --hard origin/main`)으로 동작한다.

## 사용

```bash
jini doctor                        # CLI 설치·인증 진단 (먼저 여기부터)
jini                               # 대화형 (마스터=claude)
jini "src 의 테스트 실패 원인 찾아"    # 1회 실행
jini --to gemini "이 논문 요약해"     # 특정 프로바이더로
jini panel "이 설계의 약점은?"        # 3사 동시 질의 후 나란히 비교
```

세션 명령: `/to <provider>` `/panel <질문>` `/doctor` `/cost` `/new` `/exit`

## 토큰을 어디서 아끼는가

레버는 백엔드에 따라 갈린다. 정직하게 말하면 **계정 로그인(CLI) 방식에서는 API 파라미터 레버를 쓸 수 없다** — 컨텍스트 관리가 벤더 하네스 안에서 일어나기 때문이다. 그래서 절감은 오케스트레이션 층에서 이뤄진다.

### A. cli 백엔드 (기본 · 계정 로그인)

| # | 기법 | 구현 위치 |
|---|---|---|
| 1 | 작업별 프로바이더 라우팅 — 리서치는 gemini, 리뷰는 codex, 판단은 claude | `--to` · `/to` |
| 2 | 세션 재사용(`--resume`)으로 컨텍스트 재전송 회피, 필요할 때만 `/new` | `src/cli.js:askProvider` |
| 3 | 프롬프트 stdin 전달 — 재인용·이스케이프로 인한 중복 텍스트 없음 | `src/providers/index.js` |
| 4 | 토큰 원장 — claude는 실제 비용(`total_cost_usd`), gemini·codex는 토큰 실측 | `src/agent/ledger.js` |

### B. api 백엔드 (`--backend api` · 키 필요)

| # | 기법 | 구현 위치 | 효과 |
|---|---|---|---|
| 1 | 최소 시스템 프롬프트(**실측 803자 · 15줄**), 동적 값 0 | `src/agent/system.js` | 상시 프리픽스 축소 + 캐시 무효화 방지 |
| 2 | 프롬프트 캐싱 — **브레이크포인트 3개**(system 1 + 최근 user 턴 2, 상한 4 준수) | `src/agent/loop.js:applyCacheBreakpoints` | 반복 프리픽스 입력가 0.1배 |
| 3 | 도구 스키마 지연 로딩(`defer_loading` + `tool_search`) | `src/tools/registry.js` | 안 쓰는 도구 스키마를 컨텍스트에서 제외 |
| 4 | 서버측 컨텍스트 편집(`clear_tool_uses_20250919`) | `src/agent/loop.js:betaParams` | 오래된 도구 결과를 전송 대상에서 제거 |
| 5 | 파일 전문 대신 줄 창(기본 200줄) + 재읽기 중복 제거 | `src/tools/exec.js:read` | 에이전트 루프 최대 중복원 제거 |
| 6 | 도구 결과 상한(기본 8000자) 후 포인터 | `src/tools/exec.js:execTool` | 폭주하는 명령 출력 차단 |
| 7 | diff 기반 편집(`edit`, 유일 일치 강제) | `src/tools/exec.js:edit` | 파일 재작성 출력 토큰 제거 |
| 8 | `effort` 자동 강등 — **첫 턴 + 직전 도구 미사용 + 입력 280자 이하** 3조건 동시 충족 시에만 한 단계 | `src/agent/router.js:pickEffort` | 사고 토큰 조절 |
| 9 | 토큰 원장(캐시 읽기/쓰기 분리 계상) | `src/agent/ledger.js` | 절감 효과를 추정이 아니라 실측 |

주 모델 기본값은 `claude-opus-5`다. 비용 절감을 위해 임의로 하위 모델로 내리지 않는다 — 모델 선택은 `--model` 로 사용자가 정한다.

> 이 표는 CSO 독립 검수(2026-08-01)에서 10종 중 2종이 코드와 불일치, 1종이 수치 과대로 판정돼 수정한 결과다.
> 삭제된 항목: "기계적 보조 작업만 소형 모델로 라우팅" — `pickModel` 은 저장소 어디에서도 호출되지 않는
> 죽은 코드였다. 문서만 맞추는 대신 함수를 제거했다.

## 설정

우선순위: `~/.jini/config.json` → 프로젝트 `.jini.json` → CLI 플래그.

```json
{
  "backend": "cli",
  "master": "claude",
  "providerModels": { "claude": null, "gemini": null, "codex": null },
  "model": "claude-opus-5",
  "shortInputChars": 280,
  "effort": "medium",
  "maxTokens": 16000,
  "readWindow": 200,
  "toolResultCap": 8000,
  "deferTools": true,
  "contextEditing": true,
  "autoApprove": false
}
```

## 안전 경계

- 모든 파일 도구는 작업 루트 밖 경로를 거부한다(`resolveIn`).
- `write` · `edit` · `bash` 는 실행 전 승인을 받는다(`--yolo` 로 생략).
- `git` 도구는 읽기 전용 하위명령만 허용한다.

## 개발

```bash
npm run selftest   # 네트워크 없이 13개 검증
npm start          # 로컬 실행
```

## 상태

- **M1**: api 백엔드 에이전트 루프, 파일·검색·셸 도구, 승인 게이트, 토큰 원장, 설치 프로그램
- **M1-R(현재)**: 계정 로그인 프로바이더 계층(claude·gemini·codex), `doctor`, `panel`, 세션 재사용
  - 실측: selftest **20/20** · 3사 왕복 성공(claude 26.3s · codex 30.5s · gemini 12.0s)
- M2(예정): 프로바이더 간 위임 파이프라인(마스터가 리서치·리뷰를 분배하고 취합), MCP
- M3(예정): cys 멀티노드 오케스트레이션 통합

### 알려진 공백

- `gemini`만 계정 로그인이 아니라 **API 키 인증**으로 동작한다(`~/.gemini/settings.json` 의
  `security.auth.selectedType = "gemini-api-key"`, 그리고 `GOOGLE_API_KEY`/`GEMINI_API_KEY` 환경변수).
  `jini doctor` 가 이 상태를 감지해 경고한다.

  계정 로그인으로 바꾸려면 **사람이 한 번 대화형으로** 마쳐야 한다 — `selectedType` 을
  `oauth-personal` 로 바꾸면 CLI 가 브라우저 인증 페이지를 열고 `[Y/n]` 동의를 요구하므로
  헤드리스로는 완결되지 않는다(2026-08-01 실측: `FatalCancellationError: Authentication cancelled`).

  ```bash
  # 1) 대화형으로 gemini 실행 → /auth 에서 "Login with Google" 선택 → 브라우저 동의
  gemini
  # 2) 완료 후 환경변수 해제(키가 있으면 키가 우선한다)
  #    PowerShell: Remove-Item Env:GOOGLE_API_KEY, Env:GEMINI_API_KEY
  # 3) 확인
  jini doctor
  ```
