# (b)안 프리픽스 차분 실측 + regex vs bm25 비교 (2.5)

> worker-2 · 2026-08-03 · 대상 커밋 `7db905e`(api 경로 (b)안 배선)
> 질문 둘: ①스킬 0개일 때와 120개일 때 프리픽스가 얼마나 달라지는가 ②검색 변종 둘 중 무엇을 쓰는가.

## 0. 요약 (숫자만)

| 항목 | 값 | 성격 |
|---|---:|---|
| 상시 프리픽스 증가((b)안, 스킬 120개) | **0 토큰** | 문서 계약 + 구조 확인 |
| 전 정의를 프리픽스에 넣었을 경우(=회피한 비용) | **+16,166 토큰** | **차분 실측** |
| 검색 1회로 펼쳐지는 5건의 실제 비용 | **+835 토큰** | **차분 실측** |
| CLI 백엔드(`--plugin-dir`, 회피 불가) | +11,221 토큰/호출 | 기존 실측(2026-08-03) |
| 도구 배열 바이트: 비지연부 / 지연 스킬부 | 1,997 B / 42,770 B | 결정론 |

## 1. 측정 방법 (재현 가능)

API 키가 없어 Messages API 를 직접 호출할 수 없다. 기존과 같은 **인증된 `claude` CLI 차분 측정**을 쓴다.

```bash
printf '%s' "측정용 텍스트다. 아래 내용은 읽지 말고 OK 한 글자만 출력하라.
$(cat <측정대상>)" \
  | claude -p --output-format json --model claude-opus-5 \
  | python3 -c "import json,sys;u=json.load(sys.stdin)['usage'];print(u['input_tokens']+u['cache_creation_input_tokens']+u['cache_read_input_tokens'])"
```

측정대상 파일은 우리 코드가 실제로 만드는 도구 정의 JSON 이다.

```bash
node -e "import('./src/tools/skills.js').then(m=>require('fs').writeFileSync('defs_all.json',JSON.stringify(m.skillTools())))"
```

## 2. 실측 결과

| 조건 | 총 프롬프트 토큰 | baseline 대비 차분 |
|---|---:|---:|
| baseline(측정문만) | 44,553 | 기준 |
| baseline + **스킬 정의 120개 전량** | 60,719 | **+16,166** |
| baseline + **정의 5개**(검색 1회 반환 상한) | 45,388 | **+835** |

- baseline 44,553 은 2차 설계 때의 baseline 44,552 와 **1토큰 차**다 — 두 측정이 같은 자를 쓰고 있다는 교차확인.
- 5건 기준 평균 167토큰/스킬, 120건 전량 기준 평균 135토큰/스킬(설명 길이 편차).

**이 측정의 성격(과대 주장 금지)**: 정의 JSON 을 *사용자 텍스트로* 넣어 잰 값이다.
API 가 도구 정의를 내부 직렬화하는 형식과 완전히 같지는 않을 수 있다. 자릿수·상대비교용 근사치이며,
정확한 값은 `ANTHROPIC_API_KEY` 로 실제 요청을 보내야 확정된다.

## 3. 프리픽스 증가 0 의 근거

공식 문서 원문(2026-08-03 fetch, platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool):

> "`defer_loading` controls what enters the context window, not what you send in the request:
> You still send every tool's full definition in the `tools` array on every request, including the deferred ones."
>
> "Internally, the API excludes deferred tools from the system-prompt prefix. When Claude discovers a
> deferred tool through tool search, the API appends a `tool_reference` block inline in the conversation,
> then expands it into the full tool definition before passing it to Claude. **The prefix is untouched,
> so prompt caching is preserved.**"

우리 구조가 그 조건을 만족하는지는 결정론으로 확인했다(`node`, 커밋 `7db905e`):

| 조건 | 도구 총수 | 비지연 | 지연 | 비지연부 바이트 |
|---|---:|---:|---:|---:|
| 스킬 0개(매니페스트 없음) | 10 | 7 | 3 | 1,997 |
| 스킬 120개 | 130 | 7 | 123 | **1,997** |

**비지연부는 바이트 단위로 동일하다 = 프리픽스에 실리는 부분이 스킬 설치로 변하지 않는다.**
스킬 120개가 늘리는 42,770바이트는 전부 `defer_loading: true` 쪽이다.
(`deferTools: false` 분기에는 스킬을 아예 넣지 않는다 — 넣으면 이 42,770바이트가 통째로 프리픽스가 된다.)

## 4. 3안 비용 비교

| 방식 | 상시(매 호출) | 발견 시 추가 | 근거 |
|---|---:|---:|---|
| (a) 전체 색인을 system 에 주입 | +12,666 | 0 | 기존 실측(1.4) |
| **(b) 지연 도구 + tool_search (채택)** | **0** | **+835**(5건) | 본 문서 §2·§3 |
| CLI 백엔드 `--plugin-dir` | +11,221 | 0 | 2차 설계 실측 |

CLI 경로의 +11,221 은 벤더가 색인을 주입하는 방식이라 우리가 0으로 만들 수 없다(E4 수용 판정).
api 경로는 우리가 요청을 조립하므로 0이 된다 — **두 백엔드의 비용 구조가 다른 것은 설계가 아니라 제약이다.**

## 5. regex vs bm25 (2안 비교)

### 5-1. 문서가 말하는 차이 (1차 출처)

| | `tool_search_tool_regex_20251119` | `tool_search_tool_bm25_20251119` |
|---|---|---|
| 질의 형식 | **Python `re.search()` 패턴**(자연어 아님) | **자연어 질의** |
| 대소문자 | 무시(case-insensitive) | — |
| 길이 상한 | 패턴 200자 | 질의 500자 |
| 검색 대상 | 이름·설명·인자 이름·인자 설명(양쪽 동일) | 좌동 |
| 반환 | 기본 최대 5건(양쪽 동일) | 좌동 |

### 5-2. 우리 코퍼스에서의 검색성 — 로컬 실측(regex 쪽만 가능)

regex 변종의 의미론은 공개돼 있어(`re.search` + IGNORECASE) **로컬에서 그대로 재현**할 수 있다.
현재 120개 정의(이름 + 설명)에 대해 한국어 질의 12건을 패턴으로 옮겨 돌린 결과:

- **정답 스킬 포함 11/12**
- 1회 검색이 5건 상한을 넘긴 사례 **0건**(최다 3건)
- 유일한 실패: "전세 실거래가 알려줘" → 패턴 `실거래가|전월세` 가 `real-estate-search` 를 못 잡음.
  원인은 그 스킬 **설명이 전부 영어**("real transaction price and rent lookups")라서다.
  `real transaction` 으로 바꾸면 정확히 잡힌다.

bm25 쪽은 **같은 방식으로 잴 수 없다** — 서버 토크나이저·파라미터가 공개돼 있지 않아 로컬 재현이
불가능하고, 임의의 로컬 BM25 로 대체하면 비교가 아니라 창작이 된다. **그래서 측정하지 않았다.**

### 5-3. 권고 — regex 유지(현행 유지 · 근거 있는 보류)

1. 한국어 코퍼스에서 **토크나이저 의존이 없다.** regex 는 부분문자열 일치라 조사·어미 결합
   (`공시지가는`/`공시지가를`)과 무관하게 걸린다. BM25 의 한국어 토큰화 거동은 문서에 없다 —
   *모르는 것을 근거로 바꾸지 않는다.*
2. **한 패턴에 한국어와 영어를 함께 넣을 수 있다**(`로또|lotto`). 설명 언어가 섞인 이 모음집에서
   실제로 효과가 있었다(§5-2 — `맞춤법|spell` 은 영어 쪽으로 맞았다).
3. 200자 상한은 12건 실측에서 한 번도 문제되지 않았다(최장 패턴 24자).

**단, 이 권고는 "regex 가 bm25 보다 낫다"는 주장이 아니다.** bm25 를 재보지 않았으므로
우열은 미확정이다. 확정하려면 API 키로 같은 질의 12건을 두 변종에 태워 정답 포함률을 비교해야 한다.

## 6. 이 코퍼스의 발견성 한계 2건 (기록)

| 한계 | 규모 | 뜻 |
|---|---:|---|
| 설명에 한글이 **하나도 없는** 스킬 | **21/120** | 한국어 패턴만으로는 안 잡힌다. 영어 키워드 병기 필요 |
| 설명에 부정문이 있어 반대 의미로 걸리는 스킬 | 2/120 | `gongsijiga-search` 설명의 "**실거래가가 아니다**"가 `실거래가` 패턴에 걸린다 |

둘 다 **벤더 설명 원문의 성질**이다. 우리는 description 을 가공하지 않는다는 설계 결정을 지켰으므로
(발견용으로 벤더가 쓴 문장이다) 이 한계는 남는다. 완화책은 모델이 한·영 병기 패턴을 쓰는 것이고,
그건 프롬프트가 아니라 검색 재시도로 해결되는 문제다(빈 결과는 에러가 아니라 빈 배열로 온다).

## 7. 남는 미측정 항목 (정직 고지)

- **api 경로의 실제 프리픽스 토큰**: 키가 없어 Messages API 로 직접 재지 못했다. §3 은 문서 계약 +
  우리 구조의 결정론 확인이지 실호출 실측이 아니다.
- **bm25 변종의 정답 포함률**: §5-2 사유로 미측정.
- **검색 왕복 지연**: 서버측 검색 1회가 붙는 만큼 첫 응답이 늦어진다. 측정하지 않았다.
