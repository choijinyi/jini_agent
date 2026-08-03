# 최종 검증 — 성공기준 대비 실측 대조 (worker-2 / jini-agent k-skill 레인)

> 2026-08-03 · 대상 HEAD `093ac65` · selftest **82개 통과 exit 0**
> 이 문서는 "됐다"가 아니라 **무엇을 어떻게 재서 그렇게 판정했는지**를 남긴다.
> 재지 못한 것은 §4 에 따로 모았다.

## 1. 성공기준 대비

| # | 기준 | 판정 | 근거(실측) |
|---|---|---|---|
| ① | `npm run skills:install` 로 설치된다 | **충족** | 허용목록 120 = 매니페스트 120 = 디스크 120 = PROVENANCE 120 (`npm run skills:verify` 6종 전부 ok). 보류 3종 유입 0 · AGPL 유입 0 |
| ② | 에이전트가 맥락에 맞는 스킬을 **스스로 찾아** 본문을 적재한다 | **cli 경로 충족 · api 경로 구조까지 확인** | cli: `runProvider('claude')` 실호출에서 승인 `korean-` 16개 = 모델이 보고한 16개 완전일치·보류분 누출 0. api: 요청에 실리는 도구 130개 중 스킬 120개가 전부 `defer_loading:true`, 발견은 `tool_search` 가 서버측에서 수행(실호출은 §4-1) |
| ③ | 스킬 목록 변경이 프롬프트 캐시를 무효화하지 않는다(개정본) | **충족** | 비지연부 바이트가 스킬 0개일 때와 120개일 때 **둘 다 1,997B**. `buildSystem` 은 스킬 유무와 무관하게 바이트 동일(selftest 고정). 목록은 이름 오름차순 고정(입력 순서 무관 · selftest 고정) |
| ④ | selftest 전항 통과 | **충족** | **82개 통과 exit 0**(착수 시 48 → 82). 신규 34건 중 (b)안 13 · 설치검증 6 · 벤더CLI우회 3 · check-upstream 3 · E1 5 · 게이트 회귀 4 |
| ⑤ | 문서화 | **충족** | README 「스킬 체계」 절 — 주입 방식·실측 토큰치·게이트·상류와 다른 점 3종·갱신 3단 절차·잔여 위험·`flight-ticket-search` pip/venv 고지 |

### 오너 D1 확장 (api 전용 → cli·데스크톱 앱까지)

| 경로 | 상태 | 근거 |
|---|---|---|
| `cli` 백엔드(기본) | 자동 적용 | `providers/index.js` 조건부 `--plugin-dir`. 매니페스트 부재 시 argv **바이트 동일** |
| 데스크톱 앱(Electron) | 자동 적용 | 앱은 `backend: 'cli'` 고정이라 위 경로를 그대로 상속(호출부 무수정) |
| `api` 백엔드 | 자동 적용 | `registry.js` 지연 분기에 스킬 120개 병합 |
| `gemini` | 보류(master E2) | 영속 상태 변경(`skills link`)을 요구 — argv 무변경 확인 |
| `codex` | 미지원(master E3) | 스킬 기전 미발견 — argv 무변경 확인 |

## 2. 오너 직접 지시(설치 스크립트) 대비

> "새 사용자가 클론+install 만으로 스킬이 자동 적용되고, 설치 후 검증을 출력하며,
> 스킬 부재 시에도 설치가 실패하지 않을 것. ⚠설치기가 네트워크에서 스킬을 다시 받게 만들지 마라."

**실측 방법**: 이 저장소를 임시 폴더에 `git clone` 하고(원격 아님 · 네트워크 미사용),
`npm install` 도 하지 않은 상태에서 확인했다.

| 조건 | 실측 결과 |
|---|---|
| 클론만으로 스킬이 온다 | 클론 파일 528개 중 **skills 추적분 482개** · `skills/.claude-plugin/plugin.json` 존재 |
| 설치 후 검증 출력 | `node src/tools/skills-verify.js` → `120개 · 고정 커밋 06d017ac0531` + 검사 6종 전부 `ok` · exit 0 |
| 자동 적용 | `skillsPluginDir()` = HIT → claude argv 에 `--plugin-dir <clone>/skills` 부착 · api 경로 도구 130개(스킬 120, 전부 지연) |
| **스킬 부재 시 실패 금지** | `skills/` 삭제 후 → verify `none` **exit 0** · `skillsPluginDir()` = null · argv `["-p","--output-format","json"]`(도입 전과 동일) · 스킬 도구 0 · selftest exit 0 |
| **네트워크 재다운로드 금지** | `install.sh`·`install.ps1` 에 `skills-install.js`·`skills:install`·`codeload` **미포함**(selftest 가 기계 검증). 설치기는 `skills-verify.js` 만 부른다 |

정합이 어긋나면 FAIL 줄과 **어긋난 항목 이름**을 찍되 설치는 계속한다(경고). 설치를 세우는 것은
자기검증(selftest) 실패뿐이다.

## 3. 공급망 경로 봉쇄 (벤더링만으로는 닫히지 않던 구멍)

스킬 본문은 벤더링 후에도 `npx ... @nomadamas/k-skill ...` 를 지시한다. 모델이 그대로 따르면
네트워크로 나가고, 감사한 바이트가 아니라 **그 시점 npm 판본**이 실행된다.

| 하위명령 | 우리 처리 | 결과 |
|---|---|---|
| `instruct` | 프로세스 없이 로컬 `instruction.md` + 우리 안전 규약 반환 | 네트워크 0 |
| `files` | 로컬 동봉 파일 목록 반환 | 네트워크 0 |
| `exec` | `skills/<이름>/<경로>` 사본을 **셸 없이**(argv) 실행 | 네트워크 0 |
| 가로채지 않는 경우 | 경로 탈출 · 미설치 스킬 · 모르는 확장자 · 없는 파일 | 원래 명령 그대로(임의 실행 금지) |

바꿔치기는 결과 첫 줄에 찍는다 — 조용한 대체 금지.
실측: `exec kosis-stats scripts/run_kosis_stats.py -- --help` 를 벤더 문법으로 호출하면
로컬 사본이 실행되고 헬퍼의 실제 usage 출력이 나온다.

## 4. 재지 못한 것 (정직 고지 — "확인했다"로 쓰지 않는다)

1. **api 실호출**: `ANTHROPIC_API_KEY` 가 없어 Messages API 로 직접 보내지 못했다.
   프리픽스 0은 **공식 문서 계약 + 우리 구조의 결정론 확인**까지이고 실호출 실측이 아니다.
   같은 이유로 "모델이 실제로 `tool_search` 를 불러 스킬을 찾는" 장면도 api 경로에서는 못 봤다
   (cli 경로에서는 봤다 — §1 ②).
2. **bm25 변종**: 서버 토크나이저·파라미터가 공개돼 있지 않아 로컬 재현이 불가능하다.
   regex 만 로컬 실측했고(정답 포함 11/12), **우열은 미확정**이다.
3. **검색 왕복 지연**: 서버측 검색 1회가 붙는 만큼 첫 응답이 늦어진다 — 측정하지 않았다.

### 4-1. 이 미측정을 어떻게 볼 것인가 (master 판정 2026-08-03 · 레인 최종 상태 확정)

**「문서 계약 + 구조 확인까지」가 이 레인의 최종 상태다. 키는 제공하지 않는다.**

근거: **미측정 항목은 미측정 사용자 경로에 속한다.**
api 경로는 `--backend api` 로만 열리고 그 플래그 자체가 `ANTHROPIC_API_KEY` 를 요구한다.
즉 **키가 없는 사용자는 그 경로에 애초에 도달하지 못한다.** 없는 키로만 갈 수 있는 길을
없는 키로 재지 못했다는 것은 결함이 아니다.
반면 오너가 실제로 쓰는 기본 경로(cli 백엔드 · 창 앱)는 **E2E 실증이 있다**
(`korean-` 질의 16개 = 모델 보고 16개 완전일치 · 보류분 누출 0 — §1 ②).

### 4-2. 키가 생겼을 때 재개할 측정 절차 (무엇을 어떻게 재면 되는가)

1. **프리픽스 0 실호출 확인** — 같은 대화를 `--backend api` 로 2회 보내고 `usage` 를 받아
   `input_tokens`(캐시 제외분)를 비교한다. 스킬 0개 설치본과 120개 설치본의 **비지연 프리픽스
   바이트가 동일**함은 이미 확인했으므로(1,997 B 고정), 실호출에서도 두 설치본의
   `input_tokens` 가 같아야 한다. 다르면 지연 로딩 계약이 깨진 것이다.
2. **`tool_search` 실제 호출 관찰** — 한국어 질의를 주고 응답 스트림에서 `tool_search` 도구
   사용 블록이 나오는지, 이어서 `skill_*` 정의가 그때 실려 오는지 확인한다.
   비교 기준: 정의 120개 전량 선적재 시 **+16,166 토큰** vs 검색 1회 **+835 토큰**(둘 다 기측정).
3. **검색 왕복 지연** — 같은 질의를 `deferTools: true/false` 로 각 5회 보내 첫 토큰까지의
   시간 차를 잰다. 이것이 지연 로딩의 유일한 실비용이다.
4. **bm25 대조** — `tool_search_tool_bm25_20251119` 로 위 2번을 반복해 regex 와 회수율을
   비교한다. 로컬 재현이 불가능한 이유(서버 토크나이저 비공개)는 사라지지 않으므로
   **실호출만이 이 항목을 열 수 있는 유일한 경로**다.

## 4-B. 실측된 결함 — 발견성 한계 2건 (미측정이 아니다 · 대장 등재)

**master 판정: 이것은 「재지 못한 것」이 아니라 재서 나온 결함이므로 대장에 올린다.**
아래는 벤더 설명 원문의 성질이고, 우리가 만든 것이 아니지만 **우리가 고를 때 알고 있었어야 하는 것**이다.

| # | 결함 | 실측 | 왜 문제인가 |
|---|---|---|---|
| 1 | 설명에 한글이 하나도 없는 스킬 | **21 / 120** | 한국어 질의로는 이 21개가 **안 잡힐 수 있다.** 이 모음집의 목적(한국인용)과 정면으로 어긋난다 |
| 2 | 부정문 때문에 반대 의미로 걸리는 스킬 | **2건** | 「~에는 쓰지 마라」가 그 단어로 검색되어 오히려 호출된다 |

해당 21개(정본 파서 `loadSkills` 기준 · 이름 오름차순):

```
building-register-search  foresttrip-vacancy      hwp
joseon-sillok-search      k-skill-cleaner         kbo-results
korean-character-count    korean-heritage-search  korean-law-search
korean-middle-korean      korean-patent-search    korean-slang-writing
korean-spell-check        korean-stock-search     lotto-results
naver-blog-research       real-estate-search      rhwp-advanced
rhwp-edit                 seoul-subway-arrival    zipcode-search
```

⚠ **집계 방법 주의(측정 함정 실기록)**: 이 21 을 즉석 정규식
`/^description:\s*(.*)$/m` 으로 다시 세면 **23** 이 나온다. `gongsijiga-search` ·
`housing-official-price` 두 건이 YAML 블록 스칼라(`description: |`)를 써서 첫 줄이 비어 있고,
한글은 둘째 줄부터 나오기 때문이다. **정본은 21** 이며 근거는 저장소의 프런트매터 파서
(`loadSkills` — PyYAML 대조 120/120 일치)다. 재검증하는 사람은 즉석 정규식을 쓰지 마라.

**다음 레인 후보(착수 전 오너 판단 필요)**: 이 21개에 한국어 트리거를 보강할지.
보강은 **상류 원문 변경**이므로 `PROVENANCE.json` 의 `modifications` 에 고지해야 하고,
갱신 3단 절차(커밋 재고정 → skillscan 재실행 → 면제기록 재발행)의 대상이 된다.
즉 「설명만 손보는 간단한 일」이 아니다 — 그래서 판단 대상으로 올리고 착수하지 않았다.

## 5. 남는 위험 (없어지지 않는다)

k-skill 을 쓴다는 것은 **에이전트가 제3자 파이썬 코드를 런타임에 실행할 수 있다**는 뜻이며,
이는 이 모음집의 본질적 성질이라 벤더링으로 사라지지 않는다.
우리가 한 것은 제거가 아니라 **고정·선별·기록**이다.
실행은 전부 `bash` 승인 게이트를 지나고, `flight-ticket-search` 는 실행 시 네트워크 `pip install`
과 디스크 `venv` 생성이 일어난다.

## 6. 증거 파일

| 파일 | 내용 |
|---|---|
| `kskill-waivers.jsonl` | skillscan 123행 건별 판정(면제는 규칙이 아니라 판정) |
| `kskill-tier3-review.md` | T3/T3b 개별검토 목록 |
| `npx-bypass-feasibility.md` | instruct·exec 우회 가능성 실측(스크립트 74개 sha256 동일) |
| `runtime-rules-coverage.md` | 상류 Runtime rules 항목 대 항목 대조표 + 우리 안전 문구 정본 |
| `b-plan-prefix-measurement.md` | (b)안 토큰 차분 실측 · regex 검색성 · 미측정 고지 |
| `final-verification.md` | 이 문서 |
