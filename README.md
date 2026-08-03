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
                         │              └ 클론 → npm install → 자기검증 → 셈 생성 → PATH → 스킬 확인
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

설치 스크립트는 클론 → `npm install --omit=dev` → **자기검증** → 실행 셈 생성 → PATH 등록 → **스킬 확인** 순으로 수행한다. 재실행하면 갱신(`git reset --hard origin/main`)으로 동작한다.

자기검증이 실패하면 실행 셈을 만들지 않고 **중단한다**(깨진 설치가 실행 가능한 상태로 남지 않도록).

마지막 **스킬 확인** 단계는 [스킬 체계](#스킬-체계-k-skill-벤더링) 절의 내용을 요약해 화면에 찍는다.

- 이 저장소에는 한국 생활·업무용 스킬 **120개**가 **함께 커밋돼 있다.** 클론하면 딸려오므로
  새로 설치하는 사람이 따로 받을 것은 없고, 설치 스크립트도 **네트워크에서 다시 받지 않는다** —
  받는 것이 아니라 고정 커밋과 맞는지 **확인만** 한다(검사 6종을 출력).
- 스킬이 없거나(직접 지웠거나 얕은 체크아웃) 정합이 어긋나도 **설치는 실패하지 않는다.**
  경고만 찍고 계속하며, 그때 에이전트는 스킬 없이 정상 동작한다.
- 확인 단계는 **잔여 위험**도 함께 고지한다: 이 스킬들은 실행 시 제3자 파이썬 코드를 돌릴 수 있고,
  우리가 한 것은 그 능력의 제거가 아니라 **감사한 판본에의 고정·선별·기록**이다. 자세한 내용은
  [남는 위험](#남는-위험-없어지지-않는다) 절에 있다.

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

## 스킬 체계 (k-skill 벤더링)

한국 생활·업무용 스킬 모음집 [NomaDamas/k-skill](https://github.com/NomaDamas/k-skill)(MIT)을
저장소 안에 벤더링해 **양쪽 백엔드에서 자동으로 적용**한다.

```bash
npm run skills:verify    # 설치된 스킬 정합 확인(네트워크 없음) — install.ps1/install.sh 가 자동 실행
npm run skills:install   # 고정 커밋 tarball → skills/ 에 승인분만 배치(관리자용 · 갱신할 때만)
```

**새로 설치하는 사람은 아무것도 더 하지 않아도 된다.** `skills/` 는 저장소에 함께 추적되므로
클론 시점에 이미 배치돼 있고, 설치 스크립트는 그것을 **받지 않고 확인만 한다**(검사 6종을 출력).
스킬이 없거나 정합이 어긋나도 **설치는 실패하지 않는다** — 에이전트는 스킬 없이 정상 동작하고,
그때 `claude` argv 는 스킬 도입 전과 바이트 단위로 같다.

전역(`-g`) 설치가 아니다. 배치처는 이 저장소의 `skills/` 뿐이고 사용자 홈·다른 프로젝트를 건드리지 않는다.

### 어떻게 적용되는가

| 백엔드 | 주입 방식 | 상시 프리픽스 비용 |
|---|---|---:|
| `cli`(기본) | `claude --plugin-dir <repo>/skills` — 세션 한정, 홈·프로젝트 무변경 | **+11,221 토큰 — 호출마다 지불** |
| `api` | 스킬 1개 = **지연 로딩 도구 1개**(`defer_loading`) + `tool_search` | **0** |

cli 쪽 +11,221 은 **매 호출 지불된다.** "반복 호출은 프롬프트 캐시가 흡수한다"고 적었던 이전 서술은
실측으로 반증됐다 — 같은 호출을 두 번 해도 총 프롬프트 토큰이 59,728 / 59,734 로 거의 같았다.
jini 는 매 턴 `claude -p` 를 일회성 프로세스로 띄워 세션이 새로 잡히기 때문이다(줄어드는 것은 금액뿐 —
0.4071 → 0.3760 USD, 7.6%). 이 비용은 벤더가 색인을 주입하는 방식이라 우리가 0으로 만들 수 없다.

api 경로는 모델이 필요할 때 `tool_search` 로 스스로 찾고, 그때 그 정의만 컨텍스트에 올라온다
(검색 1회 최대 5건 = **+835 토큰 실측**). 전 정의를 미리 올렸다면 **+16,166 토큰**이 매 호출 붙는다 —
그 차이가 지연 로딩을 쓰는 이유다. 측정 방법과 원자료는 `_round/evidence/b-plan-prefix-measurement.md`.

- 노출 목록은 `skills/.claude-plugin/plugin.json` **하나가 정한다** — 두 백엔드가 같은 파일을 본다.
  매니페스트가 없으면 양쪽 다 스킬 0개다.
- 목록은 항상 이름 오름차순으로 고정한다. 순서가 흔들리면 도구 배열이 바뀌고 프롬프트 캐시가 통째로 날아간다.
- `deferTools: false` 로 두면 api 경로에 스킬을 **싣지 않는다**(즉시 로드 분기에 넣으면 프리픽스가 폭증한다).

### 무엇이 걸러졌나

설치 대상은 저장소의 123개 중 **120개**다. 게이트를 통과한 것만 들어온다.

- `javis_skillscan` 전수 검사 → 판정 기록 `_round/evidence/kskill-waivers.jsonl`(123행).
  면제는 규칙 변경이 아니라 **건별 판정**으로 남긴다(검증 인프라는 손대지 않는다).
- 제외 3종: `k-skill-setup`(사용자 crontab 에 매일 09:00 작업을 영속 설치하는 안내 포함) ·
  `gov-overseas-trip-report` · `corporate-registration-consulting`.
- AGPL-3.0 인 `packages/k-skill-proxy` · `infra/k-skill-proxy-dashboard` 는 이름 화이트리스트 구조상
  복사될 수 없다. Apache-2.0 2건은 `LICENSE.upstream` 을 동봉한다.

### 상류와 다른 점 (우리가 가한 변경 — 은닉하지 않는다)

`skills/PROVENANCE.json` 의 `modifications` 에 기록돼 있다.

1. **부동 semver 고정**: 스킬 본문의 `@nomadamas/k-skill@0`(0.x 전체를 떠도는 범위) → `@0.2.2`.
   479곳/177파일. 지침 조회·helper 실행 경로가 감사한 판본에 고정된다.
2. **로컬 본문 제공 + 벤더 CLI 우회**: 스킬 도구는 네트워크(`npx ... instruct`) 대신
   **로컬 `instruction.md`** 를 돌려준다. 나아가 지침이 벤더 CLI 를 부르라고 지시해도
   `bash` 도구 앞단에서 가로채 로컬 사본으로 돌린다 — `instruct`·`files` 는 프로세스 없이
   로컬 내용으로 답하고, `exec` 는 `skills/<이름>/<경로>` 사본을 **셸 없이** 실행한다.
   무엇으로 바꿨는지는 결과 첫 줄에 찍는다(조용한 바꿔치기 금지).
   스킬 디렉터리 밖을 가리키거나 실행기를 모르는 경우에는 손대지 않고 원래 명령을 그대로 둔다.
3. **머리말 대체**: 상류 CLI 는 출력 앞에 자체 Runtime rules 를 붙이는데, 우리는 그것을 복제하지 않고
   **우리 안전 규약**을 붙인다. 그 머리말은 jini 에 존재하지 않는 `clarify` 도구를 부르라고 지시하고,
   "조회에서 멈추지 말고 실행까지 진행하라"는 우리 경계와 반대인 조항을 포함한다.
   항목 대 항목 대조는 `_round/evidence/runtime-rules-coverage.md`.

이 트레이드오프는 명시해 둔다: 고정한 대가로 **벤더의 정당한 버그·보안 패치도 자동으로는 들어오지 않는다.**

### 갱신 절차 (3단 — 순서 고정)

1. **커밋 재고정** — 먼저 `npm run skills:install -- --check-upstream` 으로 고정 커밋과 upstream
   최신의 차이를 **읽기만** 한다(뒤처진 커밋 수와 바뀐 스킬 이름을 찍고 아무것도 바꾸지 않는다).
   그다음 `src/tools/skills.allowlist.json` 의 `source.commit`(필요하면 `npx_pin`)을 손으로 바꾼다.
   자동 갱신 경로는 만들지 않았다 — 지름길이 있으면 아래 2·3단을 건너뛸 수 있기 때문이다.
2. **skillscan 재실행** — 새 판본 전수를 다시 검사한다. 규칙·`rules.json` 은 고치지 않는다.
3. **면제기록 재발행** — 위양성 면제는 규칙이 아니라 **그 판본에 대한 판정**이므로 `kskill-waivers.jsonl` 을
   새로 쓴다. 이때 `runtime-rules-coverage.md` 의 대조표도 다시 돌린다(상류 머리말이 바뀌었을 수 있다).

### 남는 위험 (없어지지 않는다)

k-skill 을 쓴다는 것은 **에이전트가 제3자 파이썬 코드를 런타임에 실행할 수 있다**는 뜻이며,
이는 이 모음집의 본질적 성질이라 벤더링으로 사라지지 않는다.
우리가 한 것은 제거가 아니라 **고정·선별·기록**이다.

- 실행은 전부 `bash` 도구를 거치고 `bash` 는 승인 게이트 대상이다(`--yolo` 면 그 게이트가 없다).
- `flight-ticket-search` 는 실행 시 네트워크 `pip install` 과 디스크 `venv` 생성이 일어난다.
- 스킬 본문 앞에는 항상 안전 규약이 붙는다 — 결제·예매·발송·최종 제출·계정 변경 같은 비가역 동작은
  실행 직전에 멈추고 사용자 승인을 받는다. 자격증명 입력은 대신하지 않는다.

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
npm run selftest   # 네트워크 없이 82개 검증
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
