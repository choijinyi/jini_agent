/**
 * k-skill 벤더링 설치기. `npm run skills:install`
 *
 * 설계 결정 3가지(master 승인 D3 — 벤더 CLI 대신 자체 벤더링):
 *  1) 커밋 고정. 브랜치가 아니라 `skills.allowlist.json` 의 commit sha 로 tarball 을 받는다.
 *     같은 명령이 언제 돌아도 같은 바이트를 배치한다.
 *  2) 화이트리스트만 복사. 채택 게이트(javis_skillscan)를 통과한 스킬 이름만 복사하므로
 *     AGPL 인 packages/k-skill-proxy · infra/k-skill-proxy-dashboard 는 구조적으로 복사될 수 없다
 *     (최상위 스킬 디렉터리 이름 목록에 존재하지 않는다).
 *  3) 전역 설치 금지. 배치처는 이 저장소 안 `skills/` 뿐이며 사용자 홈을 건드리지 않는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
export const SKILLS_DIR = path.join(ROOT, 'skills');
const ALLOWLIST = path.join(HERE, 'skills.allowlist.json');

/** 스킬 이름 화이트리스트. 경로 조작(`..`·절대경로·구분자)을 이름 단계에서 차단한다. */
export const SAFE_NAME = /^[a-z0-9][a-z0-9-]*$/;

export function loadAllowlist(file = ALLOWLIST) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  // approved 아래의 **모든** 등급 배열을 합친다. 등급 키를 하드코딩하면 master 가 새 등급을
  // 승인해도 설치기가 조용히 무시한다 — 2026-08-03 T3/T3b 승인분 20개가 실제로 누락됐다.
  const names = Object.values(doc.approved).flat();
  const bad = names.filter((n) => !SAFE_NAME.test(n));
  if (bad.length) throw new Error(`허용되지 않는 스킬 이름: ${bad.join(', ')}`);
  if (new Set(names).size !== names.length) throw new Error('허용목록에 중복이 있습니다');
  return { doc, names };
}

function run(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { stdio: 'inherit', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${bin} 실패(exit ${r.status})`);
}

/**
 * 상류 원문의 부동 semver 를 고정판으로 치환한다(master 지시).
 *
 * SKILL.md·instruction.md 는 전체 지침과 helper 실행을 `npx -y @nomadamas/k-skill@0 ...` 로 받아온다.
 * `@0` 은 0.x 전체를 떠도는 범위라 실행 시점마다 다른 코드일 수 있다. 스텁을 지우면 스킬이 빈
 * 껍데기가 되므로(실제 지침이 그 경로로 온다) **버전 토큰만** 고정한다.
 *
 * 뒤에 숫자·점이 오면 매칭하지 않는다 — 이미 고정된 문자열을 다시 치환해 `@0.2.2.2.2` 를
 * 만드는 것을 막는다(멱등).
 */
export const NPX_FLOATING = /(@nomadamas\/k-skill)@0(?![\d.])/g;

export function pinNpxVersion(dir, version) {
  let files = 0;
  let hits = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.(md|txt)$/i.test(e.name)) continue;
      const src = fs.readFileSync(p, 'utf8');
      const n = (src.match(NPX_FLOATING) || []).length;
      if (!n) continue;
      fs.writeFileSync(p, src.replace(NPX_FLOATING, `$1@${version}`), 'utf8');
      files++;
      hits += n;
    }
  };
  walk(dir);
  return { files, hits };
}

/**
 * ★출고 본문 치환 2종 (독립검증 지적 A′·B′ — 2026-08-03)
 *
 * 대조표를 상류 **머리말**만 대상으로 삼은 것이 범위 결함이었다. 모델이 실제로 받는 것은
 * SAFETY 규약 + **벤더 본문**이고, 머리말에서 없앤 두 결함이 본문에 그대로 남아 있었다.
 * 손편집하면 재설치에 되살아나므로 `pinNpxVersion` 과 같은 층(설치기)에 넣는다.
 *
 * ⚠순서 의존: B′ 를 먼저 돌려야 한다. A′ 를 먼저 돌리면 B′ 문장이
 * 「승인 게이트 통과 후 공식 결제 표면으로 완료한다」로 바뀌어 **경계 위반이 그대로 남는다.**
 * `applyBodyPolicy` 가 그 순서를 강제한다.
 */

/** B′: 결제 실행까지 밀어붙이는 문장. 오너 경계(실행·예약·결제 금지)와 정면 충돌한다. */
export const PAYMENT_OVERRIDE =
  /^.*결제 자동화 금지는 generic fallback에만 적용한다\..*완료한다.*$/gm;

export const PAYMENT_OVERRIDE_TEXT =
  '- 결제·예매·발권은 이 스킬이 대신 완료하지 않는다. 조회와 후보 제시까지만 하고, ' +
  '실제 결제·예약은 사용자가 공식 표면에서 직접 마친다 ' +
  '(jini 경계 — 상류 원문이 예외를 두어 결제 완료를 지시했으나 우리 정책으로 대체했다)';

/**
 * B″: 「Done when」 절이 **결제·예매 완료를 성공 조건으로** 못박은 문장.
 *
 * 범위를 출고 페이로드 전체로 넓히자(지시 3항) 새로 드러난 것이다 — 독립검증이 지적한 B′ 2곳은
 * `## Notes` 절이었고, 이쪽은 `## Done when` 절이라 양쪽 스캔이 모두 놓쳤다.
 * A′ 치환만으로는 부족하다: 도구 이름을 실재 기전으로 바꿔도 **「결제를 완료해야 끝」이라는 목표가
 * 그대로 남기 때문이다.** 기전을 고치고 목표를 두면 모델은 여전히 결제로 향한다.
 *
 * 장바구니 담기(`장바구니에 담긴 것을 확인했다`)는 **일부러 건드리지 않았다** — 결제·예약이 아니고
 * 오너·master 가 지적한 경계도 그것이 아니다. 판단이 필요한 항목이라 master 에 올린다.
 */
export const PAYMENT_DONE = /^-\s*돌쇠.*(결제|주문번호|예매|예약 흐름).*확인했다.*$/gm;

export const PAYMENT_DONE_TEXT =
  '- 결제·예매 요청이면 **대신 완료하지 않고**, 공식 표면 링크와 사용자가 확인할 항목' +
  '(금액·일정·인원·환불 조건)을 정리해 넘겼다 ' +
  '(jini 경계 — 상류는 결제 완료를 완료 조건으로 삼았으나 우리 정책으로 대체했다)';

/**
 * A′: 존재하지 않는 `clarify` 도구 호출 지시. 안전 조항이 문자로만 있고 기전이 없는 상태가
 * 가장 나쁘다 — 거짓 보증을 만들기 때문이다. 실재하는 기전(NEEDS_APPROVAL 승인 게이트)으로 이름을 바꾼다.
 */
export const CLARIFY_CALL = /`clarify`로/g;
export const CLARIFY_AFTER = /`clarify` 승인 후/g;
const CLARIFY_CALL_TEXT = '승인 게이트(`write`·`edit`·`bash`·`git`)에서';
const CLARIFY_AFTER_TEXT = '승인 게이트 통과 후';

/** `.md`/`.txt` 를 훑어 주어진 치환쌍을 적용한다. 반환값은 파일수·건수. */
function rewrite(dir, pairs) {
  let files = 0;
  let hits = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.(md|txt)$/i.test(e.name)) continue;
      const src = fs.readFileSync(p, 'utf8');
      let out = src;
      let n = 0;
      for (const [re, to] of pairs) {
        n += (out.match(re) || []).length;
        out = out.replace(re, to);
      }
      if (!n) continue;
      fs.writeFileSync(p, out, 'utf8');
      files++;
      hits += n;
    }
  };
  walk(dir);
  return { files, hits };
}

/** 출고 본문 정책 치환. 치환 후 잔존을 스스로 검사해 반환한다(멱등 — 재실행 시 hits 0). */
export function applyBodyPolicy(dir) {
  const payment = rewrite(dir, [
    [PAYMENT_OVERRIDE, PAYMENT_OVERRIDE_TEXT], // B′ (Notes 절)
    [PAYMENT_DONE, PAYMENT_DONE_TEXT], // B″ (Done when 절) — 둘 다 A′ 보다 먼저
  ]);
  const clarify = rewrite(dir, [
    [CLARIFY_AFTER, CLARIFY_AFTER_TEXT],
    [CLARIFY_CALL, CLARIFY_CALL_TEXT],
  ]);
  return { payment, clarify, residual: scanBodyPolicy(dir) };
}

/**
 * 치환이 놓친 잔존을 전수 보고한다. 위 두 패턴이 아닌 형태로 `clarify` 가 쓰였을 수 있으므로
 * **치환 성공을 가정하지 않고 다시 센다** — 「고쳤다」와 「고쳐졌다」는 다르다.
 * (실제로 이 검사가 3번째 형태를 하나 잡아냈다. 확인해 보니 위양성이었지만, 그 판별을
 *  사람이 눈으로 한 것이 아니라 이 검사가 후보를 내놓은 덕에 가능했다.)
 *
 * **`clarify` 를 도구로 지시하는 형태만 결함으로 센다.** 판별 기준은 백틱 표기(`` `clarify` ``)와
 * 「clarify 도구/tool」이다. 산문 속 영어 낱말(예: 제목 `### 1. Clarify the need` — 「필요를
 * 명확히 하라」는 뜻)은 도구 호출 지시가 아니므로 결함이 아니고, `prose` 로 따로 보고한다.
 * 이 구분을 하지 않으면 잔존 0 을 영원히 만족시킬 수 없고, 반대로 산문을 지워 버리면
 * 상류 본문을 뜻 없이 훼손한다.
 */
export function scanBodyPolicy(dir) {
  const clarify = [];
  const prose = [];
  const payment = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.(md|txt)$/i.test(e.name)) continue;
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const rel = path.relative(dir, p);
        const at = `${rel}:${i + 1}`;
        if (/`clarify`|clarify\s*(도구|tool)/i.test(line)) clarify.push(at);
        else if (/clarify/i.test(line)) prose.push(at);
        if (/결제 자동화 금지는 generic fallback/.test(line) || PAYMENT_DONE.test(line)) {
          payment.push(at);
        }
        PAYMENT_DONE.lastIndex = 0; // /g 정규식은 상태를 갖는다 — 줄마다 초기화해야 건너뛰지 않는다
      });
    }
  };
  walk(dir);
  return { clarify, prose, payment };
}

/**
 * Claude Code 플러그인 매니페스트를 쓴다. 벤더 CLI 는 이 파일의 `skills` 목록만 보므로
 * **설치 목록이 곧 노출 목록**이 된다 — 채택 게이트가 런타임까지 관철되는 지점이다.
 *
 * 목록은 항상 **이름 오름차순으로 정렬**한다. 순서가 흔들리면 프리픽스가 바뀌어
 * 프롬프트 캐시가 무효화된다(성공기준 3 — 지켜야 할 대상은 파일이 아니라 캐시다).
 */
export function writePluginManifest(dir, names) {
  const manifest = {
    name: 'jini-k-skill',
    description: 'jini 벤더링 k-skill — 채택 게이트 통과분만',
    version: '1.0.0',
    license: 'MIT',
    skills: [...names].sort().map((n) => `./${n}`),
  };
  const out = path.join(dir, '.claude-plugin');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

/**
 * 허용목록에 없는 스킬 디렉터리를 지운다.
 *
 * 이게 없으면 승인을 철회해도 이미 배치된 디렉터리가 남아 계속 노출된다.
 * **회수할 수 없는 게이트는 게이트가 아니라 한 방향 밸브다** — 그래서 설치의 일부다.
 */
export function pruneExtraneous(dir, keepNames) {
  const keep = new Set(keepNames);
  const pruned = [];
  for (const d of fs.readdirSync(dir)) {
    const p = path.join(dir, d);
    if (!fs.statSync(p).isDirectory() || keep.has(d) || d === '.claude-plugin') continue;
    fs.rmSync(p, { recursive: true, force: true });
    pruned.push(d);
  }
  return pruned;
}

/** 디렉터리 재귀 복사(Node 16.7+ 의 cpSync). 대상이 있으면 지우고 새로 넣는다. */
function replaceDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

export function install({ tarball } = {}) {
  const { doc, names } = loadAllowlist();
  const { repo, commit } = doc.source;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jini-skills-'));
  const tgz = path.join(tmp, 'src.tar.gz');

  if (tarball) fs.copyFileSync(tarball, tgz);
  else {
    const url = `https://codeload.github.com/${repo}/tar.gz/${commit}`;
    console.log(`받는 중: ${repo}@${commit.slice(0, 12)}`);
    run('curl', ['-sSL', url, '-o', tgz]);
  }
  // tar 는 cwd 를 tmp 로 두고 **상대 경로**로 호출한다. GNU tar 는 `C:\...` 의 콜론을
  // 원격 호스트 지정(host:path)으로 해석해 "Cannot connect to C" 로 실패한다 — 2026-08-03 실측.
  run('tar', ['-xzf', 'src.tar.gz'], { cwd: tmp });

  const roots = fs.readdirSync(tmp).filter((d) => fs.statSync(path.join(tmp, d)).isDirectory());
  const base = path.join(tmp, roots.find((d) => d.startsWith('k-skill-')) || roots[0]);

  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  const placed = [];
  const missing = [];
  for (const name of names) {
    const src = path.join(base, name);
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) {
      missing.push(name);
      continue;
    }
    replaceDir(src, path.join(SKILLS_DIR, name));
    placed.push(name);
  }

  const pruned = pruneExtraneous(SKILLS_DIR, placed);

  const pin = pinNpxVersion(SKILLS_DIR, doc.source.npx_pin);
  const body = applyBodyPolicy(SKILLS_DIR);
  writePluginManifest(SKILLS_DIR, placed);

  // 라이선스 고지. 루트 MIT 원문을 함께 둔다(스킬별 LICENSE.upstream 은 디렉터리째 복사되므로 자동 동봉).
  fs.copyFileSync(path.join(base, 'LICENSE'), path.join(SKILLS_DIR, 'LICENSE.k-skill'));
  fs.writeFileSync(
    path.join(SKILLS_DIR, 'PROVENANCE.json'),
    JSON.stringify(
      {
        repo,
        commit,
        installed: placed.length,
        // 상류 원문에 우리가 가한 변경은 반드시 여기 적는다. MIT 라 변경은 허용되지만 은닉은 안 된다.
        modifications: [
          {
            what: `@nomadamas/k-skill@0 → @nomadamas/k-skill@${doc.source.npx_pin}`,
            why: '부동 semver(@0=0.x 전체) 제거. 지침 조회·helper 실행 경로를 감사한 판본에 고정한다.',
            files: pin.files,
            occurrences: pin.hits,
          },
          {
            what:
              '「결제 자동화 금지는 generic fallback에만 적용한다 … 공식 결제 표면으로 완료한다」 ' +
              '→ 「결제·예매·발권은 이 스킬이 대신 완료하지 않는다 …」',
            why:
              '상류 원문이 특정 환경에서는 결제를 완료하라고 예외를 두는데, jini 경계는 ' +
              '설치는 하되 실행·예약·결제를 금지한다. 정면 충돌이라 우리 정책 문구로 대체했다. 삭제가 아니라 치환이다.',
            files: body.payment.files,
            occurrences: body.payment.hits,
          },
          {
            what: '`clarify` 도구 호출 지시 → 승인 게이트(`write`·`edit`·`bash`·`git`) 문구',
            why:
              'jini 에 `clarify` 라는 도구는 존재하지 않는다(실도구 10종에 없음). 모델이 부를 수 없는 ' +
              '도구로 승인을 받으라고 지시하면 안전 절차가 실행되지 않는데 문서상으로는 안전 조항이 있는 ' +
              '상태가 된다 — 조항이 없는 것보다 나쁘다(거짓 보증). 실재하는 기전인 NEEDS_APPROVAL 승인 ' +
              '게이트로 이름을 바꿨다. 조항을 옮긴 것이 아니라 기전을 실재화한 것이다.',
            files: body.clarify.files,
            occurrences: body.clarify.hits,
          },
        ],
        names: placed.sort(),
      },
      null,
      2
    ) + '\n'
  );

  fs.rmSync(tmp, { recursive: true, force: true });
  if (missing.length) throw new Error(`저장소에 없는 스킬: ${missing.join(', ')}`);
  return { placed, pruned, pin, body, dir: SKILLS_DIR, commit };
}

/**
 * 고정 커밋과 upstream 최신의 차이를 **읽기 전용**으로 보고한다. `--check-upstream`
 *
 * 자동 갱신 경로는 만들지 않는다 — 갱신은 커밋 재고정 → skillscan 재실행 → 면제기록
 * 재발행의 3단을 사람이 밟아야 하고, 그 순서를 건너뛰는 지름길이 있으면 게이트가 무력화된다.
 * 그래서 이 경로는 **알려주기만 하고 아무것도 바꾸지 않는다.**
 */
export async function checkUpstream({ fetchJson = defaultFetchJson } = {}) {
  const { doc } = loadAllowlist();
  const { repo, commit } = doc.source;
  const branch = doc.source.branch || 'main';
  const head = await fetchJson(`https://api.github.com/repos/${repo}/commits/${branch}`);
  const latest = head.sha;
  if (latest === commit) return { repo, branch, pinned: commit, latest, behind: 0, changed: [] };

  // 고정본과 최신 사이의 파일 차이. 스킬 디렉터리 이름 단위로 접어서 본다.
  const cmp = await fetchJson(`https://api.github.com/repos/${repo}/compare/${commit}...${latest}`);
  const changed = [...new Set((cmp.files || []).map((f) => f.filename.split('/')[0]))].sort();
  return {
    repo,
    branch,
    pinned: commit,
    latest,
    behind: cmp.behind_by ?? (cmp.total_commits || 0),
    ahead: cmp.ahead_by,
    changed,
  };
}

async function defaultFetchJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'jini-agent' } });
  if (!r.ok) throw new Error(`GitHub API ${r.status} ${r.statusText} — ${url}`);
  return r.json();
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('skills-install.js')) {
  if (process.argv.includes('--check-upstream')) {
    const r = await checkUpstream();
    console.log(`저장소 ${r.repo}@${r.branch}`);
    console.log(`  고정 ${r.pinned.slice(0, 12)}`);
    console.log(`  최신 ${r.latest.slice(0, 12)}`);
    if (r.latest === r.pinned) {
      console.log('  차이 없음 — 고정본이 최신이다.');
    } else {
      console.log(`  뒤처짐 ${r.ahead ?? r.behind}커밋 · 변경된 최상위 항목 ${r.changed.length}개`);
      for (const c of r.changed.slice(0, 40)) console.log(`    - ${c}`);
      if (r.changed.length > 40) console.log(`    ... 외 ${r.changed.length - 40}개`);
      console.log('\n  이 명령은 아무것도 바꾸지 않았다. 갱신하려면 3단을 밟아라:');
      console.log('   1) skills.allowlist.json 의 source.commit 재고정');
      console.log('   2) javis_skillscan 재실행(규칙은 고치지 않는다)');
      console.log('   3) 면제기록(kskill-waivers.jsonl) 재발행 + runtime-rules 대조표 재실행');
    }
  } else {
    const arg = process.argv.indexOf('--tarball');
    const r = install({ tarball: arg > 0 ? process.argv[arg + 1] : undefined });
    console.log(`설치 ${r.placed.length}개 · 제거 ${r.pruned.length}개 · npx고정 ${r.pin.hits}곳/${r.pin.files}파일 → ${r.dir}`);
  }
}
