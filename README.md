# Jini Agent

터미널에서 도는 코딩 에이전트. 기능은 일반적인 코딩 에이전트와 같되, **같은 작업을 더 적은 토큰으로** 끝내는 것을 설계 목표로 삼는다.

- 백엔드: Anthropic Messages API (`@anthropic-ai/sdk`) — 의존성 1개, 빌드 단계 없음
- 런타임: Node.js 20+
- 설치: git 저장소 + 설치 스크립트(`install.ps1` / `install.sh`)

## 설치

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
jini                       # 대화형
jini "src 의 테스트 실패 원인 찾아"   # 1회 실행
jini --effort low -p "README 오타 고쳐"
```

세션 명령: `/cost` `/model <id>` `/effort <lv>` `/tools` `/clear` `/exit`

## 토큰을 어디서 아끼는가

| # | 기법 | 구현 위치 | 효과 |
|---|---|---|---|
| 1 | 최소 시스템 프롬프트(≈450토큰), 동적 값 0 | `src/agent/system.js` | 상시 프리픽스 축소 + 캐시 무효화 방지 |
| 2 | 프롬프트 캐싱 — system 1개 + 직전·현재 user 턴 2개 (상한 4개 준수) | `src/agent/loop.js:applyCacheBreakpoints` | 반복 프리픽스 입력가 0.1배 |
| 3 | 도구 스키마 지연 로딩(`defer_loading` + `tool_search`) | `src/tools/registry.js` | 안 쓰는 도구 스키마를 컨텍스트에서 제외 |
| 4 | 서버측 컨텍스트 편집(`clear_tool_uses_20250919`) | `src/agent/loop.js:betaParams` | 오래된 도구 결과를 전송 대상에서 제거 |
| 5 | 파일 전문 대신 줄 창(기본 200줄) + 재읽기 중복 제거 | `src/tools/exec.js:read` | 에이전트 루프 최대 중복원 제거 |
| 6 | 도구 결과 상한(기본 8000자) 후 포인터 | `src/tools/exec.js:execTool` | 폭주하는 명령 출력 차단 |
| 7 | diff 기반 편집(`edit`, 유일 일치 강제) | `src/tools/exec.js:edit` | 파일 재작성 출력 토큰 제거 |
| 8 | `effort` 기본 medium + 단순 1턴 질의 자동 강등 | `src/agent/router.js` | 사고 토큰 조절 |
| 9 | 기계적 보조 작업만 소형 모델로 라우팅 | `src/agent/router.js:pickModel` | 판단 품질은 주 모델 유지 |
| 10 | 토큰 원장(캐시 읽기/쓰기 분리 계상) | `src/agent/ledger.js` | 절감 효과를 추정이 아니라 실측 |

주 모델 기본값은 `claude-opus-5`다. 비용 절감을 위해 임의로 하위 모델로 내리지 않는다 — 모델 선택은 `--model` 로 사용자가 정한다.

## 설정

우선순위: `~/.jini/config.json` → 프로젝트 `.jini.json` → CLI 플래그.

```json
{
  "model": "claude-opus-5",
  "fastModel": "claude-haiku-4-5",
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

- M1(현재): 에이전트 루프, 파일·검색·셸 도구, 승인, 토큰 원장, 캐싱·지연로딩·컨텍스트편집, 설치 프로그램
- M2(예정): 서브에이전트 위임, MCP 서버 연결
- M3(예정): cys 멀티노드 오케스트레이션 통합
