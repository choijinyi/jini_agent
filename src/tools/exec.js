import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { isSkillTool, skillBody, rewriteVendorCommand } from './skills.js';

/**
 * 심링크·정션까지 해소한 실제 경로를 기준으로 루트 포함 여부를 판정한다.
 * 문자열 정규화(path.resolve)만으로는 루트 안의 링크가 밖을 가리킬 때 통과된다
 * — reviewer-gemini 지적 ②-1, 2026-08-01 정션으로 재현 확인된 실결함.
 */
function realpathBestEffort(abs) {
  const missing = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...missing.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs; // 루트까지 못 찾음 — 원본 사용
      missing.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** 작업 루트 밖으로 나가는 경로를 거부한다(경로 탈출·심링크 탈출 방지). */
function resolveIn(cfg, p) {
  if (!p) throw new Error('path 가 비어 있습니다');
  const root = realpathBestEffort(path.resolve(cfg.cwd));
  const real = realpathBestEffort(path.resolve(root, p));
  const rel = path.relative(root, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`작업 루트 밖 경로 거부: ${p}`);
  }
  return real;
}

function sha(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
}

/**
 * 읽기 캐시 — 같은 파일의 같은 구간을 같은 내용으로 다시 읽으면
 * 본문 대신 포인터만 돌려준다. 에이전트 루프에서 가장 큰 중복 토큰원.
 */
const readCache = new Map(); // key: abs:offset:limit -> {hash, turn}

function numbered(lines, start) {
  return lines.map((l, i) => `${String(start + i).padStart(5)}\t${l}`).join('\n');
}

const TOOLS = {
  read(cfg, { path: p, offset = 1, limit }) {
    const abs = resolveIn(cfg, p);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) throw new Error(`디렉터리입니다: ${p}`);
    const win = limit || cfg.readWindow;
    const all = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
    const start = Math.max(1, offset);
    const slice = all.slice(start - 1, start - 1 + win);
    const body = numbered(slice, start);

    const key = `${abs}:${start}:${win}`;
    const h = sha(body);
    const prev = readCache.get(key);
    if (prev && prev.hash === h) {
      return `(unchanged since earlier read: ${p} lines ${start}-${start + slice.length - 1})`;
    }
    readCache.set(key, { hash: h });

    const more =
      all.length > start - 1 + win
        ? `\n... (${all.length - (start - 1 + win)} more lines; use offset=${start + win})`
        : '';
    return body + more;
  },

  write(cfg, { path: p, content }) {
    const abs = resolveIn(cfg, p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    readCache.clear();
    return `wrote ${p} (${content.length} chars)`;
  },

  edit(cfg, { path: p, old, new: neu, all = false }) {
    const abs = resolveIn(cfg, p);
    const src = fs.readFileSync(abs, 'utf8');
    const count = src.split(old).length - 1;
    if (count === 0) throw new Error(`일치 없음: ${p} 에서 old 문자열을 찾지 못했습니다`);
    if (count > 1 && !all) throw new Error(`${count}건 일치 — 고유하게 지정하거나 all:true 를 쓰세요`);
    const out = all ? src.split(old).join(neu) : src.replace(old, neu);
    fs.writeFileSync(abs, out, 'utf8');
    readCache.clear();
    return `edited ${p} (${all ? count : 1} replacement)`;
  },

  glob(cfg, { pattern, path: base }) {
    const root = resolveIn(cfg, base || '.');
    const re = globToRegex(pattern);
    const out = [];
    walk(root, root, out, re, 4000);
    return out.length ? out.join('\n') : '(no matches)';
  },

  grep(cfg, { pattern, path: base, glob: g, max = 60 }) {
    const root = resolveIn(cfg, base || '.');
    const re = new RegExp(pattern);
    const fileRe = g ? globToRegex(g) : null;
    const files = [];
    if (fs.statSync(root).isFile()) files.push(root);
    else walk(root, root, files, fileRe, 4000, true);

    const hits = [];
    for (const f of files) {
      if (hits.length >= max) break;
      let text;
      try {
        text = fs.readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\u0000')) continue; // 바이너리 skip
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && hits.length < max; i++) {
        if (re.test(lines[i])) {
          hits.push(`${path.relative(cfg.cwd, f)}:${i + 1}:${lines[i].slice(0, 300)}`);
        }
      }
    }
    return hits.length ? hits.join('\n') : '(no matches)';
  },

  ls(cfg, { path: p }) {
    const abs = resolveIn(cfg, p || '.');
    return fs
      .readdirSync(abs, { withFileTypes: true })
      .map((d) => {
        if (d.isDirectory()) return `${d.name}/`;
        try {
          return `${d.name}\t${fs.statSync(path.join(abs, d.name)).size}`;
        } catch {
          return d.name;
        }
      })
      .join('\n');
  },

  async bash(cfg, { command, timeout = 60000 }) {
    // 스킬 지침이 지시하는 벤더 CLI 호출은 로컬 사본으로 돌린다(네트워크·부동 판본 회피).
    // 바꿔치기는 조용히 하지 않는다 — 무엇으로 바꿨는지 결과 앞줄에 찍는다.
    const local = rewriteVendorCommand(command);
    if (local?.kind === 'text') return local.text;
    if (local?.kind === 'argv') {
      // 셸을 거치지 않고 실행한다 — 경로·인자가 셸 메타문자로 재해석될 여지를 없앤다.
      return `${local.note}\n${await runArgv(local.bin, local.argv, cfg.cwd, timeout)}`;
    }
    return run(command, cfg.cwd, timeout);
  },

  /**
   * 읽기 전용 git. 셸을 거치지 않고 argv 배열로 실행한다.
   * 이전 구현은 `git ${args}` 를 shell:true 로 넘겨 'log; rm -rf /' 류의
   * 셸 메타문자 주입이 통했다 — reviewer-gemini 지적 ②-2, 재현 확인된 실결함.
   */
  async git(cfg, { args }) {
    const allowed = ['status', 'log', 'diff', 'show', 'blame', 'branch'];
    const argv = String(args).trim().split(/\s+/).filter(Boolean);
    if (!allowed.includes(argv[0])) {
      throw new Error(`읽기 전용 git 하위명령만 허용: ${allowed.join(', ')}`);
    }
    for (const a of argv) {
      if (!/^[A-Za-z0-9._\/=:@^~-]+$/.test(a)) {
        throw new Error(`git 인자에 허용되지 않는 문자: ${a}`);
      }
    }
    return runArgv('git', argv, cfg.cwd, 30000);
  },

  async count_tokens(cfg, { path: p, text }, ctx) {
    const body = text != null ? text : fs.readFileSync(resolveIn(cfg, p), 'utf8');
    const res = await ctx.client.messages.countTokens({
      model: cfg.model,
      messages: [{ role: 'user', content: body }],
    });
    return `${res.input_tokens} tokens (${cfg.model})`;
  },
};

/** 셸을 거치지 않는 실행 — 인자가 셸 메타문자로 해석될 여지를 없앤다. */
function runArgv(bin, argv, cwd, timeout) {
  return collect(spawn(bin, argv, { cwd, shell: false }), timeout);
}

/** 셸 경유 실행 — bash 도구 전용(승인 게이트로 보호된다). */
function run(command, cwd, timeout) {
  return collect(spawn(command, { cwd, shell: true }), timeout);
}

function collect(child, timeout) {
  return new Promise((resolve) => {
    let out = '';
    const cap = 200_000;
    const push = (d) => {
      if (out.length < cap) out += d.toString();
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    const timer = setTimeout(() => {
      child.kill();
      out += `\n[timeout after ${timeout}ms]`;
    }, timeout);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(`${out.trim() || '(no output)'}\n[exit ${code}]`);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve(`[spawn error] ${e.message}`);
    });
  });
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv']);

function walk(dir, root, out, re, cap, filesOnly = false) {
  if (out.length >= cap) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= cap) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, root, out, re, cap, filesOnly);
    } else {
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (!re || re.test(rel)) out.push(filesOnly ? full : rel);
    }
  }
}

/** 최소 glob: **, *, ?, {a,b} 지원. */
function globToRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') re += '(';
    else if (c === '}') re += ')';
    else if (c === ',') re += '|';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * 도구 실행 진입점. 결과는 문자열로 정규화하고 상한을 적용한다.
 *
 * 스킬 도구(`skill_*`)는 이름이 설치본에 따라 달라져 TOOLS 에 미리 넣을 수 없다.
 * 로컬 본문 조회는 읽기 전용이라 승인 게이트에 넣지 않는다 — 실제 위험 동작은
 * 전부 `bash` 를 거치고 `bash` 는 이미 승인 대상이다.
 */
export async function execTool(name, input, cfg, ctx) {
  const fn = TOOLS[name];
  const skill = !fn && isSkillTool(name);
  if (!fn && !skill) throw new Error(`알 수 없는 도구: ${name}`);
  const result = skill ? skillBody(name) : await fn(cfg, input || {}, ctx);
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  // 스킬 본문은 자체 상한(SKILL_BODY_CAP)을 이미 통과했다. 여기서 다시 8,000자로 자르면
  // 지침 중간이 잘려 그 스킬의 경계 조항이 사라진다.
  if (!skill && text.length > cfg.toolResultCap) {
    return (
      text.slice(0, cfg.toolResultCap) +
      `\n... [truncated ${text.length - cfg.toolResultCap} chars — narrow the query]`
    );
  }
  return text;
}
