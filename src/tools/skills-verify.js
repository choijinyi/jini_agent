/**
 * 설치된 스킬의 정합 검증. `npm run skills:verify`
 *
 * **네트워크를 타지 않는다.** `skills/` 는 저장소에 함께 추적되므로 clone 만으로 이미 배치돼 있다.
 * 이 스크립트가 하는 일은 받아오는 것이 아니라 **받아온 것이 맞는지 확인하는 것**이다.
 *
 * 판정 3종:
 *  - `none`  스킬이 없다(매니페스트 부재). 설치 실패가 아니다 — 에이전트는 스킬 없이 정상 동작한다.
 *  - `ok`    아래 검사 전부 통과(현재 7종).
 *  - `fail`  하나라도 어긋남. **설치를 중단시키지는 않되** 무엇이 어긋났는지 이름을 찍는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SKILLS_DIR, loadAllowlist, NPX_FLOATING, scanBodyPolicy, PENDING_JUDGMENT } from './skills-install.js';
import { loadSkills, manifestNames } from './skills.js';

/** 상류 부동 semver(`@0`)가 스킬 콘텐츠에 남아 있는지 전수 검사. */
export function scanFloating(dir) {
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.(md|txt)$/i.test(e.name)) continue;
      const n = (fs.readFileSync(p, 'utf8').match(NPX_FLOATING) || []).length;
      if (n) hits.push({ file: path.relative(dir, p), count: n });
    }
  };
  walk(dir);
  return hits;
}

export function verify(dir = SKILLS_DIR, { allowlistFile } = {}) {
  const manifest = manifestNames(dir);
  if (!manifest) return { status: 'none', checks: [] };

  const dirs = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== '.claude-plugin')
    .map((e) => e.name)
    .sort();

  const provenance = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, 'PROVENANCE.json'), 'utf8'));
    } catch {
      return null;
    }
  })();

  const { names: approved } = allowlistFile ? loadAllowlist(allowlistFile) : loadAllowlist();
  const { skills, skipped } = loadSkills(dir);
  const floating = scanFloating(dir);
  const body = scanBodyPolicy(dir);
  const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const sorted = [...manifest].sort();

  const checks = [
    {
      name: '매니페스트 = 디스크 디렉터리',
      ok: eq(sorted, dirs),
      detail: `매니페스트 ${manifest.length} · 디스크 ${dirs.length}`,
      extra: () => [
        ...dirs.filter((d) => !sorted.includes(d)).map((d) => `매니페스트에 없는 디렉터리: ${d}`),
        ...sorted.filter((m) => !dirs.includes(m)).map((m) => `디스크에 없는 항목: ${m}`),
      ],
    },
    {
      name: '매니페스트 = 채택 게이트 허용목록',
      ok: eq(sorted, [...approved].sort()),
      detail: `허용목록 ${approved.length}`,
      extra: () => sorted.filter((m) => !approved.includes(m)).map((m) => `승인되지 않은 노출: ${m}`),
    },
    {
      name: '매니페스트 = PROVENANCE 기록',
      ok: Boolean(provenance) && eq(sorted, [...(provenance.names || [])].sort()),
      detail: provenance ? `PROVENANCE ${(provenance.names || []).length}` : 'PROVENANCE.json 없음',
      extra: () => [],
    },
    {
      name: '이름 오름차순 고정',
      ok: eq(manifest, sorted),
      detail: '순서가 흔들리면 프롬프트 캐시가 무효화된다',
      extra: () => [],
    },
    {
      name: '부동 semver(@0) 잔존 0',
      ok: floating.length === 0,
      detail: `잔존 ${floating.length}건`,
      extra: () => floating.slice(0, 10).map((h) => `${h.file}: ${h.count}건`),
    },
    {
      name: '도구 노출 가능(frontmatter 파싱)',
      ok: skills.length === manifest.length,
      detail: `노출 ${skills.length} / 제외 ${skipped.length}`,
      extra: () => skipped.map((s) => `${s.name}: ${s.reason}`),
    },
    {
      // 독립검증 지적(2026-08-03): 대조 범위가 상류 머리말뿐이라 본문에 남은 결함을 놓쳤다.
      // 모델이 실제로 받는 것은 본문이므로 **출고 본문**을 검사 대상에 넣는다.
      name: '출고 본문 정책 위반 0 (부재 도구 지시·경계 충돌)',
      ok: body.clarify.length === 0 && body.payment.length === 0,
      detail: `부재 도구 지시 ${body.clarify.length}곳 · 경계 충돌 ${body.payment.length}곳`,
      extra: () => [
        ...body.clarify.map((l) => `존재하지 않는 도구 호출 지시: ${l}`),
        ...body.payment.map((l) => `실행·예약·결제 경계 충돌: ${l}`),
      ],
    },
  ];

  return {
    status: checks.every((c) => c.ok) ? 'ok' : 'fail',
    count: manifest.length,
    commit: provenance?.commit,
    checks,
  };
}

function main() {
  const r = verify();
  if (r.status === 'none') {
    console.log('[skills] 설치된 스킬 없음 — 에이전트는 스킬 없이 정상 동작한다.');
    console.log('[skills] 스킬을 쓰려면: npm run skills:install');
    return 0;
  }
  // 개수는 **매니페스트 기준**이다. 정합이 깨진 상태에서 이 숫자를 그대로 "포함돼 있다"로 쓰면
  // 디스크에 없는 것까지 있다고 말하는 셈이 된다 — 어긋났을 때는 단정하지 않는다.
  const head =
    r.status === 'ok'
      ? `이 설치에는 스킬 ${r.count}개가 포함돼 있다`
      : `스킬 ${r.count}개가 있어야 하는데 아래 검사에서 어긋난 항목이 있다`;
  console.log(`[skills] ${head} · 고정 커밋 ${(r.commit || '?').slice(0, 12)}`);
  for (const c of r.checks) {
    console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name} (${c.detail})`);
    if (!c.ok) for (const line of c.extra()) console.log(`       - ${line}`);
  }
  // 선언된 예외를 설치 화면에 **드러낸다.** 조용한 예외는 예외가 아니라 구멍이다(master 조건2).
  // 개수는 목록 길이로 찍는다 — "1건"을 박아 두면 예외가 늘 때 출력이 조용히 거짓이 된다.
  if (PENDING_JUDGMENT.length) {
    console.log(`[skills] 정책 예외 ${PENDING_JUDGMENT.length}건 (검사 통과가 아니라 판단 대기다):`);
    for (const p of PENDING_JUDGMENT) console.log(`[skills]   - ${p.at} — ${p.why}`);
  }
  // 잔여 위험 고지. 설치자가 마지막에 읽는 문장이므로 "안전합니다"라고 쓰지 않는다 —
  // 우리가 한 것은 제거가 아니라 고정·선별·기록이고, 그 차이를 숨기면 거짓 보증이 된다.
  console.log('[skills] 남는 위험: 이 스킬들은 실행 시 제3자 파이썬 코드를 돌릴 수 있다.');
  console.log('[skills]   우리는 그것을 감사한 판본에 고정하고 선별했을 뿐, 그 능력을 없애지는 않았다.');
  console.log('[skills]   실행은 bash 승인 게이트를 거친다 — 다만 --yolo 로 띄우면 그 게이트가 없다.');
  console.log('[skills]   자세한 내용은 README 의 "남는 위험" 절을 읽어라.');
  return r.status === 'ok' ? 0 : 1;
}

if (process.argv[1]?.endsWith('skills-verify.js')) process.exit(main());
