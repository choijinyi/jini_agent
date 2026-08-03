# npx 부동 @0 경로 우회 가능성 — 실측 결과 (instruct · exec 양쪽)

> worker-2 · 2026-08-03 · master 추가 과제(D7 강화분)에 대한 답
> 질문: 우리 스킬 로더가 스텁의 `npx -y @nomadamas/k-skill@0 ...` 대신 **벤더링 사본**을 가리킬 수 있는가.
> 답: **instruct·exec 양쪽 모두 가능하다.** 아래가 근거다.

## 0. 왜 중요한가 (master 지적)

벤더링만으로는 공급망 구멍이 닫히지 않는다. SKILL.md 스텁이 여전히 `npx ... @0` 을 지시하므로,
커밋 고정본을 옆에 둬도 에이전트는 스텁을 읽고 npx 를 부른다 — 벤더링은 **병렬 경로를 하나 더
만든 것**이 된다. 그리고 스텁이 지시하는 것은 `instruct`(문서 조회)만이 아니라 **`exec`(실행)까지**다.

## 1. instruct 경로 — 우회 가능

**사실 1**: `instruction.md` 가 벤더링 사본에 이미 들어 있다. 설치된 **119개 전부 보유(119/119)**.

**사실 2**: `npx ... instruct <skill>` 출력 = 고정 머리말 13줄 + 로컬 `instruction.md` **본문 그대로**.

| 스킬 | npx 출력 | 로컬 instruction.md | 로컬 본문이 npx 출력에 포함 |
|---|---:|---:|---|
| korea-weather | 4,082자 | 2,380자 | **True** |
| korean-humanizer | 17,532자 | 15,577자 | **True** |
| hwp | 6,664자 | 5,199자 | **True** |
| lotto-results | 3,036자 | 1,598자 | **True** |

diff 실측 결과 npx 가 덧붙이는 것은 아래 13줄 고정 머리말뿐이다(generic 모드):

```
# <skill> — assembled instructions
Runtime mode: generic
## Runtime rules
- Detect capabilities, not product names. Dolshoi credential mode is active only when ...
- When the user asks for an action and the official surface supports it lawfully, ...
- Immediately before an irreversible external side effect such as payment, ...
- Preserve hard boundaries for law, required physical presence, CAPTCHA, ...
- Plain lookups go through the hosted k-skill-proxy by default; no user API key ...
- This skill is lookup-oriented. Completion means the requested data is retrieved ...
```

→ 로더가 로컬 `instruction.md` 를 내주면 네트워크·부동 @0 없이 동일 본문을 제공한다.

## 2. exec 경로 — 우회 가능 (master 가 추가로 지목한 부분)

**사실 3**: 벤더링 스크립트와 npm 사본이 **바이트 동일**하다.

- npm 패키지 실측 버전: `@nomadamas/k-skill 0.2.2` (`@0` 이 현재 가리키는 것)
- npm 사본 위치: `%LOCALAPPDATA%\npm-cache\_npx\5a34daaf3243f876\node_modules\@nomadamas\k-skill\skills\`
- sha256 전수 대조 결과: **동일 74 · 상이 0 · npm에없음 0**

**사실 4**: 실행 출력도 동일하다.

```
npx -y @nomadamas/k-skill@0 exec kosis-stats scripts/run_kosis_stats.py -- --help
python3 skills/kosis-stats/scripts/run_kosis_stats.py --help
→ 둘 다 988자, 완전 동일(True)
```

shebang 은 `#!/usr/bin/env python3` 이라 별도 인터프리터 해석이 필요 없다.

→ 로더가 로컬 `skills/<name>/scripts/<file>` 를 직접 실행하면 동일 결과를 얻는다.

## 3. 한계 — 이 동일성은 시점 동일성이다

**지금 같다는 것이 앞으로 같다는 뜻이 아니다.** `@0` 은 0.x 전체를 떠도는 범위이고 오늘은 0.2.2 를
가리킨다. 다음 0.x 발행분은 우리 고정 커밋(06d017ac05317da3)과 달라질 수 있다.
그것이 바로 **우리 사본을 쓰는 이유**다 — 감사한 바이트가 계속 그 바이트로 남는다.

역으로, 우회를 구현하면 **벤더의 정당한 수정(버그·보안 패치)도 자동으로는 안 들어온다.**
갱신은 `npm run skills:install` 의 커밋 갱신으로만 이뤄지며, 그때 게이트를 다시 통과해야 한다.
이건 결함이 아니라 설계 의도(감사된 것만 들어온다)지만, 문서에 명시해야 하는 트레이드오프다.

## 4. 구현 시 남는 판단 1건 (master 판정 필요)

`instruct` 의 13줄 Runtime rules 머리말은 **CLI 가 생성**한다. 우리 로더가 이를 재현하려면
그 문구를 우리 쪽에 박아야 하는데, 그러면 **캡처 시점 판본에 고정**된다.
선택지: ①머리말까지 재현(동작 동일·문구 고정) ②본문만 제공하고 안전 문구는 우리 것으로 대체.
권고는 ② — 남의 CLI 출력 문구를 복제해 유지하는 것보다, 우리가 책임지는 안전 문구를 쓰는 편이
유지보수와 책임 소재 양쪽에서 낫다.

## 5. 재개 포인터

- 이 문서 = npx 우회 실측의 결론. 구현 전 판정 필요 항목은 §4 하나.
- 승인 상태: 설치 119개(허용목록·PROVENANCE·디스크 3자 일치), 보류 4개(PE2 2 + 설치금지 2).
- 다음 단계: master 의 E1~E4 · PE2 판정 · §4 판정 → 구현 착수.

---

## 6. 후속 조치 실행 결과 — npx 버전 고정 (master 지시 · 2026-08-03 15:0x)

**독립 검증**: npm registry 직접 조회 결과 전 판본은 `0.1.0 / 0.2.0 / 0.2.1 / 0.2.2` 4개뿐이고
`dist-tags.latest = 0.2.2`, 발행 시각 `2026-08-01T04:38:18.263Z` — 우리 고정 커밋
`06d017ac`(`04:36:55Z`)보다 **83초 뒤**다. master 판단과 내 실측이 일치한다.

**치환 실행**(설치기 `pinNpxVersion()` — 손편집 아님, 재설치마다 자동 적용):

| 항목 | 값 |
|---|---:|
| 치환 건수 | **468곳** |
| 대상 파일 | **175개** (SKILL.md 119 · instruction.md 56) |
| 스킬 콘텐츠 내 잔존 부동 `@0` | **0** |
| 재실행 후 이중치환 | **없음**(멱등 — `@0(?![\d.])` 경계 조건) |

**잔존 1건의 정체**: `skills/PROVENANCE.json` 의 고지 문장
(`"what": "@nomadamas/k-skill@0 → @nomadamas/k-skill@0.2.2"`) 안에 있는 것으로,
스킬 콘텐츠가 아니라 **우리가 가한 변경을 설명하는 문서**다. `.md/.txt/.py/.sh/.js` 어디에도 남지 않았다.

**고지**: `PROVENANCE.json` 에 `modifications` 항목으로 무엇을·왜·몇 건 바꿨는지 기록했다.
MIT 라 변경은 허용되지만 은닉은 안 된다는 원칙에 따른다.

**남는 성질(제거되지 않음)**: k-skill 을 쓴다는 것은 에이전트가 제3자 파이썬 코드를 런타임에
실행할 수 있다는 뜻이며, 이는 이 모음집의 본질적 성질이라 벤더링으로 사라지지 않는다.
우리가 한 것은 제거가 아니라 **고정·선별·기록**이다.
