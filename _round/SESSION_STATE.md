# SESSION_STATE — jini-agent 스킬 체계 레인 (worker-2 / surface:58)

> 2026-08-03 · clear 직전 저장 지점. **재개는 이 파일부터 읽는다.**
> 이 레인의 정본 설계는 `~/.cys/pack-dept-dept-2/round/WORKER2_PHASE1_DESIGN.md` ·
> `WORKER2_PHASE2_DESIGN.md`, todo 는 같은 폴더 `WORKER_2_TODO.md` 다.

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

**안 끝난 것 = 재개 지점**
1. **E1 배선** — `src/providers/index.js` claude `buildArgs` 에 **조건부** `--plugin-dir <skillsDir>`
   (스킬 디렉터리 실재 시에만. 없으면 argv 바이트 동일 = 기존 사용자 무영향)
2. 설치기가 `.claude-plugin/plugin.json` 생성(승인분만 나열 — 게이트가 런타임까지 관철되는 지점)
3. api 경로 (b)안 배선: 스킬 1개 = 지연로딩 도구 1개 + 기존 `tool_search`
4. 스킬 로더가 **로컬 `instruction.md` 직접 제공**(npx 우회 1차 방어). 벤더 Runtime rules 머리말은
   복사하지 말고 **우리 문구를 짧게**. README 에 "상류 npx 출력에는 있고 우리 경로에는 없는 것" 명시
5. `--plugin-dir` **캐시 히트 후 실비용** 측정 → README 병기(첫 호출 +11,221 만으로 단정 금지)
6. **regex vs bm25 2안 실측 비교**(같은 질의 5종으로 적중 스킬 대조) — k-skill 설명문이 한국어 산문이라
   regex 리터럴이 불리할 공산. clear 이후 수행
7. selftest 추가분(§3) · README 갱신

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
- **바이트 수로 결론짓지 말고 차분 실측으로 갈 것.**

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
