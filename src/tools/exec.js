import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

/** 작업 루트 밖으로 나가는 경로를 거부한다(경로 탈출 방지). */
function resolveIn(cfg, p) {
  if (!p) throw new Error('path 가 비어 있습니다');
  const root = path.resolve(cfg.cwd);
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`작업 루트 밖 경로 거부: ${p}`);
  }
  return abs;
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
    return run(command, cfg.cwd, timeout);
  },

  async git(cfg, { args }) {
    const allowed = ['status', 'log', 'diff', 'show', 'blame', 'branch'];
    const sub = String(args).trim().split(/\s+/)[0];
    if (!allowed.includes(sub)) throw new Error(`읽기 전용 git 하위명령만 허용: ${allowed.join(', ')}`);
    return run(`git ${args}`, cfg.cwd, 30000);
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

function run(command, cwd, timeout) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true });
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

/** 도구 실행 진입점. 결과는 문자열로 정규화하고 상한을 적용한다. */
export async function execTool(name, input, cfg, ctx) {
  const fn = TOOLS[name];
  if (!fn) throw new Error(`알 수 없는 도구: ${name}`);
  const result = await fn(cfg, input || {}, ctx);
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  if (text.length > cfg.toolResultCap) {
    return (
      text.slice(0, cfg.toolResultCap) +
      `\n... [truncated ${text.length - cfg.toolResultCap} chars — narrow the query]`
    );
  }
  return text;
}
