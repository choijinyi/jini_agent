# SESSION_STATE — jini-agent 스킬 체계 레인 (worker-2 / surface:58)

> 2026-08-03 · clear 직전 저장 지점. **재개는 이 파일부터 읽는다.**
> 이 레인의 정본 설계는 `~/.cys/pack-dept-dept-2/round/WORKER2_PHASE1_DESIGN.md` ·
> `WORKER2_PHASE2_DESIGN.md`, todo 는 같은 폴더 `WORKER_2_TODO.md` 다.

> **[상태 · 2026-08-03 16:0x · ctx 35 실측]** HEAD `093ac65` · selftest **82 통과 exit 0** ·
> 워킹트리는 `_round/` 문서만. **레인의 지시분은 전부 끝났다.**
> 최종 검증 = `_round/evidence/final-verification.md`(기준 대비 대조 + 재지 못한 것 4종).
>
> **끝난 것(이번 구간)**: 오너 직접 지시 = 설치 스크립트 스킬 반영(`skills:verify` 6종 검사 ·
> install.sh·install.ps1 배선 · **네트워크 재다운로드 없음** · 클론 E2E 실증 · 스킬 부재 시 실패 없음) ·
> 벤더 CLI 우회(instruct·files·exec) · `--check-upstream`(읽기 전용) · regex vs bm25(bm25 미측정 명시) · README.
>
> **다음(지시 대기)**: 새 지시가 없으면 이 레인은 완료 상태다. 남은 것은 §4 의 미측정 4종이며
> 그중 2건(api 실호출 · bm25)은 **API 키가 있어야 풀린다**.

## 1. 지금 어디까지 왔나

**과업**: jini-agent 에 스킬 체계를 신설하고 NomaDamas/k-skill 을 설치해 **자동 적용**시킨다.
오너 원안: "이 스킬 모음집을 jini agent 에 설치하면 자동으로 스킬을 적용하게 하는 거야."
오너 D1 결정: **api 백엔드 전용이 아니라 기본 CLI 백엔드·데스크톱 앱까지 확장**한다.

**끝난 것**
- 설계 1차·2차 완료 및 master 승인 (D2~D7 · E1~E4)
- k-skill 실측: 설치 가능 스킬 **123개**(tarball 전수 + 벤더 CLI 2경로 일치)
- 채택 게이트: `javis_skillscan` 123/123 BLOCK → 근본원인은 전 파일 공통 생성주석 1줄이
  P2·RA1 로 이중 발화한 **위양성**. 면제는 규칙이 아니라 **판정으로 기록**(`_round/evidence/kskill-waivers.jsonl` 123행)
- 등급 판정: **승인 120 / 보류 3**(k-skill-setup=crontab 영속화 · gov-overseas-trip-report · corporate-registration-consulting)
- 벤더링 설치기 `src/tools/skills-install.js` + `npm run skills:install`
  - 커밋 고정 `06d017ac05317da31ab2c8d6a9accf4ad4db70ad` · `-g` 없음 · 화이트리스트만 복사
  - **npx 부동 semver 고정**: `@nomadamas/k-skill@0` → `@0.2.2` **479곳/177파일**(멱등)
  - `PROVENANCE.json` 에 우리가 가한 변경을 `modifications` 로 고지(은닉 금지)
- 설치 정합 실측: 허용목록 120 = PROVENANCE 120 = 디스크 120 · 보류/금지 유입 0 · AGPL 유입 0
- 영속화 기전 소급 검사(설치분 전수): crontab·launchd·schtasks·HKCU Run·systemd·shell rc **전부 0건**
- selftest **52개 통과 · exit 0** (기존 48 + 회귀 4)

**안 끝난 것 = 재개 지점** (2026-08-03 15:5x 갱신 — (b)안 계열은 끝났다)

> ⚠ 이전 판본은 재개 지점을 "api 경로 (b)안 배선"으로 적었다. **그건 커밋 `7db905e` 로 끝났다.**
> 남은 것은 아래 둘뿐이다.

1. **`--check-upstream`** — `skills:install` 에 고정 커밋 vs upstream latest 차이를 **읽기 전용**으로
   보고하는 경로(자동 갱신 금지). 구현 후 README 갱신절차 1번에 문구를 되살린다.
2. **성공기준 5종 대비 최종 검증 보고 + evidence-artifact 제출**(master 앞).

**끝난 것 추가분 (커밋 7db905e · (b)안 배선)**

- **`src/tools/skills.js` 신설** — frontmatter 로더 · 도구 정의 · 로컬 본문 제공.
  - 노출 대상 = `skills/.claude-plugin/plugin.json` 목록. **CLI(`--plugin-dir`)와 같은 파일을 본다** →
    두 백엔드의 노출 집합이 하나다. 매니페스트 없으면 양쪽 다 0개.
  - 본문 = 로컬 `instruction.md`(네트워크·부동 `@0` 미경유). 안전 문구는 **본문 앞**(잘려도 규약 생존).
  - helper 는 `skills/<name>/scripts/` 사본을 쓰라고 반환값에 명시.
  - frontmatter 파서는 **PyYAML 대조 120/120 일치**(실측 형태 4종: 평문·홑따옴표·겹따옴표·블록 `|`).
- **registry.js** — 지연 분기에만 스킬 병합 · 이름 오름차순 고정 · `deferTools=false` 분기 미포함.
- **exec.js** — `skill_*` 라우팅. 스킬 본문은 `toolResultCap` 예외(지침 중간 절단 = 경계 조항 소실).
- **selftest 57 → 70 통과 exit 0**(13건 추가).
- **2.5 측정 완료** → `_round/evidence/b-plan-prefix-measurement.md`(§4 에 요약).
- **README 스킬 체계 절 신설** — ①~⑤ 조건 전부 반영 + selftest 개수 13→70 정정.

**끝난 것 추가분 (커밋 7cb3257)**
- **E1 배선**: `providers/index.js` 조건부 `--plugin-dir` + `skillsPluginDir()`.
  매니페스트 부재 시 argv 바이트 동일(무영향 보장) · gemini·codex argv 무변경 ·
  **호출부(cli.js·app/main.js·pipeline) 무수정**
- **plugin.json 생성**: 승인 120개 · 이름 오름차순 고정 · 보류 유입 0
- **E2E 실증**: `runProvider('claude')` 경로에서 승인 korean- 16 = 모델 보고 16 완전일치 ·
  보류분 누출 0 · `k-skill-setup` 미노출 · 미승인 항목 0 → **설치 목록 = 노출 목록**
- **F1 조건 이행**: 상류 머리말은 13줄이 아니라 **규칙 5항목**. 안전 제약은 R3·R4 둘이고 둘 다
  우리 문구가 더 엄격하게 덮음. 발견 결함 2건 — ①R3 이 지시하는 `clarify` 도구가 jini 에 **없다**
  ②R2 는 실행을 밀어붙이는 조항이라 우리 경계와 반대(의도적 배제)
- **selftest 57개 통과 exit 0** (기존 48 + 게이트 회귀 4 + E1 5)

## 2. ★성공기준 3 개정 (master 판정 — 지켜야 할 대상은 파일이 아니라 캐시다)

**개정 전**: "system.js 무변경(프리픽스 캐시 무효화 0)"
**개정 후**: **"스킬 목록 변경이 프리픽스 캐시를 무효화하지 않을 것"**

근거: 렌더 순서는 `tools` → `system` → `messages` 다. **도구 정의가 위치 0** 이라
스킬 목록이 흔들리면 tools·system·messages 캐시 3계층이 통째로 날아간다.
`system.js` 만 지키는 방어는 엉뚱한 곳을 지키는 것이다.
→ 설계에 **목록 안정화**를 포함한다: 정렬 고정(이름 오름차순) · 조건부 주입 · 세션 중 목록 불변.

## 3. tool_search 계약 (원문 확인분 — 구현 시 반드시 지킬 것)

- 전량 defer 금지: 최소 1개는 비-defer 여야 하고 `tool_search` 자신에 `defer_loading` 금지 → 아니면 400
- 지연 도구는 **시스템 프리픽스에서 제외**된다(공식 문서 원문) → (b)안 프리픽스 증가 0의 근거
- 검색 대상 = 도구 이름·설명·인자 이름·인자 설명 / 1회 검색 최대 5건 반환 / 지연 도구 최대 10,000개
- 지연 도구에 `cache_control` 동시 부여 시 400
- 변종 2종: `tool_search_tool_regex_20251119` · `tool_search_tool_bm25_20251119` (→ 재개 후 2안 비교)

## 4. 측정 방법 (API 키 없이 — 오너 제공 없음 확정)

`ANTHROPIC_API_KEY` 는 이 PC에 없고 제공되지 않는다. **인증된 `claude` CLI 차분 측정**으로 대체한다.
- 방식: 동일 baseline 프롬프트 + 측정대상 텍스트, `-p --output-format json --model claude-opus-5`
- 총 프롬프트 토큰 = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
- 실측 확인: 4회 반복에서 `cache_read` 24,883 고정 · `input_tokens` 2 고정 → 차분에 잡음 없음
- 기존 실측치: CORE 278 · 얇은색인 +7,272 · 전체색인 +12,666 · `--plugin-dir`(99개) +11,221
- **캐시 실측(E4 조건①)**: 동일 호출 2회 총 프롬프트 토큰 **59,728 / 59,734 — 거의 동일**.
  jini 는 매 턴 `claude -p` 를 일회성으로 띄워 세션이 새로 잡히므로 **프리픽스가 캐시에서 읽히지 않는다**.
  금액만 0.4071 → 0.3760 USD(7.6% 감소). **+11,221 은 호출마다 지불된다** —
  "반복 호출은 캐시가 흡수한다"는 내 이전 서술은 **실측으로 반증됐다. README 에 측정값을 적을 것.**
- **바이트 수로 결론짓지 말고 차분 실측으로 갈 것.**
- **(b)안 차분 실측 완료(2026-08-03 15:4x · 정본 `_round/evidence/b-plan-prefix-measurement.md`)**:
  baseline **44,553**(2차 설계 baseline 44,552 와 1토큰 차 — 같은 자를 쓰고 있다는 교차확인) ·
  스킬 정의 **120개 전량 +16,166** · **5건 +835**. 비지연부 바이트는 스킬 0개일 때와 **1,997B 동일**
  → 프리픽스 불변 구조 확인. 단 **api 실호출 실측은 키 부재로 불가**(문서 계약 + 구조 확인까지가 한계).
  regex vs bm25: regex 로컬 검색성 실측(정답 포함 11/12 · 5건 상한 초과 0) · **bm25 는 서버 토크나이저
  비공개라 재현 불가 → 미측정**. 우열 미확정이며 regex 유지 권고.
  발견 한계 2건: 설명에 한글이 없는 스킬 **21/120**(한국어 패턴만으론 미포착) · 부정문 오탐 2건.

## 5. 건드리면 안 되는 것

- `packages/k-skill-proxy` · `infra/k-skill-proxy-dashboard` = **AGPL-3.0**. 벤더링·임베드 금지(HTTP 호출만 허용)
- `javis_skillscan` 규칙·`rules.json` 변경 금지(검증 인프라 변경 = RSI 고위험). 면제는 판정 기록으로만
- 전역 설치(`-g`)·오너 홈·사용자 프로젝트 오염 금지. 배치처는 이 저장소 `skills/` 뿐
- 보류 3개 설치 금지. 특히 `k-skill-setup` 은 오너 crontab 에 매일 09:00 작업을 영속 설치하는 안내를 포함
- 스킬의 실행·예약·결제 자동화 금지(`bash` 승인 게이트로 보호)

## 6. 잔여 위험 (README 에 이 표현 그대로 — "안전해졌다"로 쓰지 말 것)

k-skill 을 쓴다는 것은 **에이전트가 제3자 파이썬 코드를 런타임에 실행할 수 있다**는 뜻이며,
이는 이 모음집의 본질적 성질이라 벤더링으로 사라지지 않는다.
우리가 한 것은 제거가 아니라 **고정·선별·기록**이다.
추가 고지: `flight-ticket-search` 는 실행 시 네트워크 `pip install` 과 디스크 `venv` 생성이 일어난다.

---

## 7. ★master 가 대신 기재한 구간 (2026-08-03 16:1x · 원장 공백 메움)

> **이 절은 worker-2 가 아니라 master 가 썼다.** 15:54:18 저장 이후 노드가 계속 작업했는데
> `/clear` 가 큐에 걸려 있어 노드 스스로 원장을 갱신할 틈이 없었다. 재개 시 이 절을 먼저 읽어라.

**★가장 중요 — 아래 파일·커밋은 전부 「네가 한 일」이다. 제3자 변경으로 오독하지 마라.**
(오늘 다른 워커가 자기 산출물을 남의 변경으로 읽고 작업을 중단한 사고가 실제로 있었다.)

### 이 구간에 커밋된 것 (git 이 정본 — 문서보다 git 을 먼저 믿어라)
- `b24aea5` feat(install): 설치 시 스킬 정합 확인 — 받지 않고 확인한다
- `09687db` docs(readme): 설치 시 스킬 확인 절차 · +11,221 호출마다 지불 명시
- `33bbaef` feat(skills): 벤더 CLI 호출을 **로컬 사본으로 우회**(instruct·files·exec)
- `093ac65` feat(skills): `--check-upstream` — 고정 커밋 vs upstream 최신을 읽기 전용으로 보고
- `81ff99f` docs(evidence): 최종 검증 문서 + 상태 갱신   ← **재개 시점 HEAD**

### 이 구간에 쓰인 파일 (master 실측 mtime)
`src/tools/skills-verify.js` 15:57:02 · `install.sh` 15:56:39 · `install.ps1` 15:56:29 ·
`package.json` 15:56:04 · `src/tools/skills.js` 16:03:09 · `src/tools/exec.js` 16:03:19 ·
`src/tools/skills-install.js` 16:05:01 · `src/selftest.js` 16:05:48 · `README.md` 16:06:27 ·
`_round/evidence/final-verification.md` 16:08:09

### master 확인분 (재작업 금지)
- **오너 지시(설치 스크립트에 스킬 반영) = 반영됨.** `install.ps1:100` · `install.sh:46` 에 스킬 확인 단계
  존재하고 `node src/tools/skills-verify.js` 를 호출한다. 주석에 「skills/ 는 저장소에 함께 추적되므로
  clone 만으로 이미 배치돼 있다」가 명시돼 있다 — **받지 않고 확인한다는 제약이 지켜졌다.**
- 미커밋은 `_round/.state_log` 하나뿐이었다(로그 파일).

### 재개 후 할 일
1. **가장 먼저** `git log --oneline -5` 와 `git status --short` 를 실행해 위 기재와 대조하라.
   어긋나면 **git 이 이긴다** — 이 문서를 고쳐라.
2. 남은 항목: regex vs bm25 2안 비교 · 캐시 히트 후 실비용 재측정 · selftest 최종 · README 마감.
3. worker(surface:56)가 커밋 `7db905e` 스냅샷으로 **독립 검증** 중이다. 그 반증이 오면 그것이 우선한다.
4. `lofi-factory` 는 네 담당이 아니다.
