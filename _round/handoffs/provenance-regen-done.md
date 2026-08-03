# handoff — provenance-regen (done)

> ⚠`HANDOFF_CONTRACT` 의 「5필드」는 여전히 **정의를 찾지 못했다**(이전 handoff 에서도 동일).
> 아래 5필드는 내가 정한 형식이고 계약 준수를 주장하지 않는다.

## 1. 무엇을 했나 (what)
`skills/PROVENANCE.json` 의 `modifications` 를 **손 나열에서 생성으로** 바꿨다. 커밋 `1720420`.
`POLICY_GROUPS` 계열 표(boundary·clarify·account-state·credential)가 치환 규칙과 원장
기재문을 함께 들고, `buildModifications()` 가 실제 적용 결과에서 원장을 만든다.
`install()` 의 하드코딩 3항목 배열은 제거했다.

## 2. 왜 (why)
치환 코드와 원장 나열이 따로 있어 **코드 3항목 대 커밋본 5항목**으로 벌어졌다.
`skills:install` 을 한 번 돌리면 B‴(계정 상태)·A″(자격증명) 기록이 조용히 사라진다 —
「은닉은 안 된다」는 원칙이 재설치 시점에 깨진다. 그리고 잡는 검사가 없었다
(`skills-verify.js` 의 `modifications` 참조 **0회** 실측).

## 3. 현재 상태 (state)
selftest **102 통과 exit 0**(직전 99 · 신규 3건). 재생성 항목 **5 = 5**,
정책 계열 건수 **6·5·7·10** 이 커밋본과 전부 일치. 멱등 2회차 전 계열 0 · sha256 차분 0.
`skills/PROVENANCE.json` 손편집 0 · `skills/` 본문 무변경 · **push 안 함**(로컬 커밋까지).

## 4. 남는 위험 (risk)
- **다음 실제 재설치 때 2항목의 `what` 문구가 바뀐다** — 손으로 붙인 낡은 줄 목록
  (`(coupang 137·142 …)`)이 빠진다. 계열·건수는 그대로다. 숨기지 않고 고지한다.
- `pinNpxVersion` 의 177/479 는 **재현하지 못했다.** 시뮬 기준본이 이미 고정된 트리라
  0/0 이 나온다. 상류 tarball 이 필요하고 그건 네트워크 경로다.
- 내 이전 주장 「치환 순서 의존」은 **철회**했다(측정으로 반박). 유효한 교훈은
  「기전과 목표를 함께 고쳐야 한다」이며 그 부분은 그대로 유효하다.

## 5. 다음 (next)
- master 판정 대기: 위 `what` 문구 변경 고지 수용 여부 · push 시점(오너 전결).
- 실제 `skills:install` 을 돌릴 기회가 생기면 npx핀 177/479 를 그때 대조하라.
- 미결 예외 1건 유지: `iros-registry-automation/instruction.md:219`(선언된 기능 · 설치 화면에 노출됨).
