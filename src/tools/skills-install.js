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
const NPX_FLOATING = /(@nomadamas\/k-skill)@0(?![\d.])/g;

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
    if (!fs.statSync(p).isDirectory() || keep.has(d)) continue;
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
        ],
        names: placed.sort(),
      },
      null,
      2
    ) + '\n'
  );

  fs.rmSync(tmp, { recursive: true, force: true });
  if (missing.length) throw new Error(`저장소에 없는 스킬: ${missing.join(', ')}`);
  return { placed, pruned, pin, dir: SKILLS_DIR, commit };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('skills-install.js')) {
  const arg = process.argv.indexOf('--tarball');
  const r = install({ tarball: arg > 0 ? process.argv[arg + 1] : undefined });
  console.log(`설치 ${r.placed.length}개 · 제거 ${r.pruned.length}개 · npx고정 ${r.pin.hits}곳/${r.pin.files}파일 → ${r.dir}`);
}
