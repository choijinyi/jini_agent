import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * 프로바이더 계층 — 계정 로그인으로 인증된 벤더 CLI 를 헤드리스로 1회 실행한다.
 * API 키를 쓰지 않는 것이 기본값이며, 인증은 각 CLI 가 이미 보유한 계정 세션이다.
 *
 * 설계 원칙 3가지
 *  1) 프롬프트는 **항상 stdin** 으로 넘긴다. argv 에 사용자 텍스트를 싣지 않으므로
 *     인용부호·개행·셸 메타문자로 명령이 깨지거나 주입되지 않는다.
 *  2) argv 에는 우리가 정한 플래그와 검증된 토큰(모델명·세션ID)만 들어간다.
 *  3) 출력 파서는 순수 함수로 분리한다(네트워크 없이 selftest 가 검증).
 *
 * 계약은 2026-08-01 실측으로 확인했다:
 *   claude -p --output-format json          → {result, session_id, usage, total_cost_usd}
 *   gemini -p "" -o json --yolo             → {response, session_id, stats.models{}.tokens}
 *   codex exec - --json                     → JSONL(thread.started / item.completed / turn.completed)
 */

const SAFE = /^[A-Za-z0-9._:@\/-]+$/; // argv 토큰 화이트리스트

function safeToken(v, label) {
  const s = String(v);
  if (!SAFE.test(s)) throw new Error(`${label} 에 허용되지 않는 문자: ${s}`);
  return s;
}

export const PROVIDERS = {
  claude: {
    id: 'claude',
    bin: 'claude',
    role: '오케스트레이션·코딩·심층추론',
    versionArgs: ['--version'],
    buildArgs({ model, session } = {}) {
      const a = ['-p', '--output-format', 'json'];
      if (model) a.push('--model', safeToken(model, 'model'));
      if (session) a.push('--resume', safeToken(session, 'session'));
      return a;
    },
    parse: parseClaude,
  },
  gemini: {
    id: 'gemini',
    bin: 'gemini',
    role: '심층리서치·리뷰',
    versionArgs: ['--version'],
    buildArgs({ model, session } = {}) {
      // -p "" : 헤드리스 모드 진입용. 실제 프롬프트는 stdin 으로 붙는다.
      const a = ['-p', '', '-o', 'json', '--yolo'];
      if (model) a.push('-m', safeToken(model, 'model'));
      if (session) a.push('--resume', safeToken(session, 'session'));
      return a;
    },
    parse: parseGemini,
  },
  codex: {
    id: 'codex',
    bin: 'codex',
    role: '코드리뷰·구현 보조',
    versionArgs: ['--version'],
    buildArgs({ model } = {}) {
      const a = ['exec', '-', '--json'];
      if (model) a.push('-m', safeToken(model, 'model'));
      return a;
    },
    parse: parseCodex,
  },
};

// ── 파서(순수 함수) ────────────────────────────────────────────────

/** stdout 앞에 붙는 경고문을 건너뛰고 첫 JSON 객체를 얻는다. */
export function firstJson(text) {
  const i = text.indexOf('{');
  if (i < 0) throw new Error('JSON 을 찾지 못했습니다');
  return JSON.parse(text.slice(i));
}

export function parseClaude(stdout) {
  const d = firstJson(stdout);
  if (d.is_error) throw new Error(d.result || 'claude 오류');
  const u = d.usage || {};
  return {
    text: d.result ?? '',
    session: d.session_id || null,
    usage: {
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cacheWrite: u.cache_creation_input_tokens || 0,
      costUSD: typeof d.total_cost_usd === 'number' ? d.total_cost_usd : null,
    },
    model: Object.keys(d.modelUsage || {})[0] || null,
  };
}

export function parseGemini(stdout) {
  const d = firstJson(stdout);
  if (d.error) throw new Error(`${d.error.message || 'gemini 오류'} (code ${d.error.code})`);
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let model = null;
  const models = d.stats?.models || {};
  for (const [name, m] of Object.entries(models)) {
    model = model || name;
    const t = m.tokens || {};
    input += t.input || 0;
    output += t.candidates || 0;
    cacheRead += t.cached || 0;
  }
  return {
    text: d.response ?? '',
    session: d.session_id || null,
    usage: { input, output, cacheRead, cacheWrite: 0, costUSD: null },
    model,
  };
}

export function parseCodex(stdout) {
  let text = '';
  let session = null;
  let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUSD: null };
  for (const line of stdout.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    let e;
    try {
      e = JSON.parse(s);
    } catch {
      continue;
    }
    if (e.type === 'thread.started') session = e.thread_id || session;
    if (e.type === 'item.completed' && e.item?.type === 'agent_message') text = e.item.text || text;
    if (e.type === 'error' || e.item?.type === 'error') throw new Error(e.message || 'codex 오류');
    if (e.type === 'turn.completed' && e.usage) {
      usage = {
        input: e.usage.input_tokens || 0,
        output: e.usage.output_tokens || 0,
        cacheRead: e.usage.cached_input_tokens || 0,
        cacheWrite: e.usage.cache_write_input_tokens || 0,
        costUSD: null,
      };
    }
  }
  if (!text) throw new Error('codex 응답에서 agent_message 를 찾지 못했습니다');
  return { text, session, usage, model: null };
}

// ── 실행 ──────────────────────────────────────────────────────────

function quoteWin(a) {
  return `"${String(a).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
}

/**
 * CLI 를 1회 실행한다. 프롬프트는 stdin 으로만 전달된다.
 * Windows 의 npm 셸(.cmd)은 shell:false 로 실행할 수 없어 cmd.exe 를 경유한다.
 */
/**
 * claude 자식 프로세스용 환경.
 *
 * 상속된 CLAUDE_CONFIG_DIR 을 제거해 **사용자의 기본 프로필**(~/.claude)로 고정한다.
 * 이게 폰 클로드 앱의 기기 연결·원격 제어가 걸려 있는 프로필이다. Jini 를 다른 프로필이
 * 설정된 터미널(예: 격리 프로필을 쓰는 도구)에서 띄우면, 그 값이 상속돼 세션이 다른
 * 계정 프로필로 만들어지고 폰 앱에서 영영 보이지 않는다 — 2026-08-01 실측으로 확인.
 *
 * cfg.claudeConfigDir 을 지정하면 그 값을 그대로 쓴다(의도적 격리용 탈출구).
 */
export function claudeEnv(configDir) {
  const env = { ...process.env };
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  else delete env.CLAUDE_CONFIG_DIR;
  return env;
}

export function spawnCli(bin, args, { cwd, env, input, timeout = 600_000 } = {}) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const child = isWin
      ? spawn(
          process.env.ComSpec || 'cmd.exe',
          // cmd.exe /c 는 문자열이 따옴표로 시작하면 첫·마지막 따옴표를 벗겨낸다.
          // 그래서 전체를 한 겹 더 감싼다(감싸지 않으면 `"claude" "--version"` 이
          // `claude" "--version` 으로 뭉개진다 — 2026-08-01 실측 버그).
          ['/d', '/s', '/c', `"${[quoteWin(bin), ...args.map(quoteWin)].join(' ')}"`],
          { cwd, env, windowsVerbatimArguments: true }
        )
      : spawn(bin, args, { cwd, env });

    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));

    const timer = setTimeout(() => {
      child.kill();
      err += `\n[timeout ${timeout}ms]`;
    }, timeout);

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: out, stderr: `${err}\n[spawn error] ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err });
    });

    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

/**
 * 프로바이더 1회 호출.
 * @returns {{text:string, usage:object, session:?string, model:?string, provider:string}}
 */
export async function runProvider(id, prompt, { cwd, model, session, timeout, claudeConfigDir } = {}) {
  const spec = PROVIDERS[id];
  if (!spec) throw new Error(`알 수 없는 프로바이더: ${id} (${Object.keys(PROVIDERS).join(', ')})`);
  const args = spec.buildArgs({ model, session });
  const env = id === 'claude' ? claudeEnv(claudeConfigDir) : undefined;
  const r = await spawnCli(spec.bin, args, { cwd, input: prompt, timeout, env });
  if (r.code !== 0 && !r.stdout.includes('{')) {
    throw new Error(`${id} 실행 실패(exit ${r.code}): ${(r.stderr || r.stdout).slice(0, 400)}`);
  }
  const parsed = spec.parse(r.stdout);
  return { ...parsed, provider: id };
}

// ── 로그인 상태 ───────────────────────────────────────────────────

/**
 * 각 CLI 가 계정 로그인을 남기는 위치(2026-08-01 실측).
 * 사용자마다 홈이 다르므로 절대경로를 박지 않고 home 을 주입받는다 — 다른 사람의 PC 에서도
 * 자기 계정 상태가 판정된다.
 */
export const LOGIN = {
  claude: {
    files: ['.claude/.credentials.json'],
    envKeys: ['ANTHROPIC_API_KEY'],
    command: 'claude auth login',
    guide: '터미널이 열리면 안내에 따라 Anthropic 계정으로 로그인하세요.',
  },
  gemini: {
    files: ['.gemini/google_accounts.json'],
    envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    command: 'gemini',
    guide: '터미널이 열리면 /auth 를 입력하고 "Login with Google" 을 선택하세요.',
  },
  codex: {
    files: ['.codex/auth.json'],
    envKeys: ['OPENAI_API_KEY'],
    command: 'codex login',
    guide: '터미널이 열리면 브라우저로 ChatGPT 계정 로그인이 진행됩니다.',
  },
};

/**
 * 로그인 상태 판정(순수 함수 — home·env 를 주입받아 테스트 가능).
 * @returns {{ok:boolean, method:'account'|'api-key'|'none', detail:string}}
 */
export function checkAuth(id, { home = os.homedir(), env = process.env } = {}) {
  const spec = LOGIN[id];
  if (!spec) return { ok: false, method: 'none', detail: '알 수 없는 프로바이더' };

  const hasFile = spec.files.some((f) => fs.existsSync(path.join(home, f)));
  const keys = spec.envKeys.filter((k) => env[k]);

  // gemini 는 설정에서 API 키 방식을 고르면 계정 로그인이 있어도 키가 우선한다.
  if (id === 'gemini') {
    let selected = null;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(home, '.gemini/settings.json'), 'utf8'));
      selected = s?.security?.auth?.selectedType || null;
    } catch { /* 설정 없음 = 미선택 */ }
    if (selected === 'gemini-api-key' || (keys.length && selected !== 'oauth-personal')) {
      return { ok: keys.length > 0, method: 'api-key', detail: `API 키 사용 중(${keys.join(', ')})` };
    }
    if (hasFile) return { ok: true, method: 'account', detail: 'Google 계정 로그인' };
    return { ok: false, method: 'none', detail: '로그인 필요' };
  }

  if (hasFile) return { ok: true, method: 'account', detail: '계정 로그인' };
  if (keys.length) return { ok: true, method: 'api-key', detail: `API 키 사용 중(${keys.join(', ')})` };
  return { ok: false, method: 'none', detail: '로그인 필요' };
}

/**
 * 설치·로그인 진단. 설치 여부(installed)와 로그인 여부(auth)를 분리해 보고한다 —
 * "설치는 됐는데 로그인이 안 된" 상태를 사용자에게 정확히 알려주기 위해서다.
 */
/**
 * claude 프로필과 원격 제어(폰 앱 연동) 상태를 본다.
 * 프로필이 기본이 아니면 폰 앱에 세션이 보이지 않는다.
 */
export function claudeProfileInfo({ home = os.homedir(), env = process.env } = {}) {
  const inherited = env.CLAUDE_CONFIG_DIR || null;
  const dir = path.join(home, '.claude');
  let remoteControl = false;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    remoteControl = s?.remoteControlAtStartup === true;
  } catch { /* 설정 없음 = 꺼짐 */ }
  return { dir, inherited, remoteControl };
}

export async function doctor(opts = {}) {
  const rows = [];
  for (const spec of Object.values(PROVIDERS)) {
    const r = await spawnCli(spec.bin, spec.versionArgs, { timeout: 60_000 });
    const installed = r.code === 0;
    const auth = installed ? checkAuth(spec.id, opts) : { ok: false, method: 'none', detail: '미설치' };
    const note = [];
    if (!installed) note.push((r.stderr || r.stdout).split('\n')[0]?.slice(0, 120) || '실행 실패');
    else if (!auth.ok) note.push('로그인 필요');
    else if (auth.method === 'api-key') note.push(`${auth.detail} — 계정 로그인 아님`);

    if (spec.id === 'claude' && installed) {
      const p = claudeProfileInfo(opts);
      if (p.inherited) note.push(`상속된 CLAUDE_CONFIG_DIR=${p.inherited} — Jini 는 무시하고 기본 프로필을 씁니다`);
      if (!p.remoteControl) {
        note.push('원격 제어 꺼짐(~/.claude/settings.json remoteControlAtStartup) — @bg 세션은 켠 채로 띄웁니다');
      }
    }

    rows.push({
      id: spec.id,
      ok: installed && auth.ok,
      installed,
      auth,
      version: installed ? r.stdout.trim().split('\n')[0] : null,
      role: spec.role,
      login: LOGIN[spec.id],
      note: note.join(' · '),
    });
  }
  return rows;
}

// ── Claude Code 백그라운드 에이전트 ──────────────────────────────

/**
 * `claude --bg` 출력에서 세션 id 를 뽑는다(순수 함수).
 * 실측 출력: "backgrounded · 405fd68f" + 안내 줄들.
 */
export function parseBackgroundId(stdout) {
  const m = stdout.match(/backgrounded\s*[·|-]\s*([0-9a-f]{6,})/i);
  if (!m) throw new Error(`백그라운드 세션 id 를 찾지 못했습니다: ${stdout.slice(0, 200)}`);
  return m[1];
}

/**
 * Claude Code 백그라운드 에이전트로 작업을 넘긴다.
 *
 * 이 세션은 `claude agents` 목록과 클로드 앱에 나타나므로 폰에서 보고 이어서 조종할 수 있다.
 * 다만 결과는 Jini 로 돌아오지 않는다 — `claude logs` 가 터미널 제어문자를 그대로 돌려줘
 * 구조적 회수가 불가능하기 때문이다(2026-08-01 실측). 그래서 파이프라인과 분리해 둔다.
 */
export async function startBackgroundClaude(task, { cwd, timeout = 120_000, claudeConfigDir } = {}) {
  // 프롬프트가 argv 로 들어가므로 줄바꿈은 공백으로 접는다(Windows argv 안전).
  const oneLine = String(task).replace(/\s*\r?\n\s*/g, ' ').trim();
  if (!oneLine) throw new Error('작업 내용이 비었습니다');
  // 세션마다 원격 제어를 켠다 — 사용자 설정에 없어도 폰 앱에서 보이도록 강제한다.
  const args = ['--bg', '--settings', '{"remoteControlAtStartup":true}', oneLine];
  const r = await spawnCli('claude', args, { cwd, timeout, env: claudeEnv(claudeConfigDir) });
  const out = `${r.stdout}\n${r.stderr}`;
  const id = parseBackgroundId(out);
  return {
    id,
    attach: `claude attach ${id}`,
    logs: `claude logs ${id}`,
    stop: `claude stop ${id}`,
  };
}

/** 실행 중인 백그라운드 에이전트 목록(클로드 앱에 보이는 것과 같은 목록). */
export async function listBackgroundAgents({ timeout = 60_000, claudeConfigDir } = {}) {
  const r = await spawnCli('claude', ['agents', '--json'], { timeout, env: claudeEnv(claudeConfigDir) });
  try {
    const all = JSON.parse(r.stdout.slice(r.stdout.indexOf('[')));
    return all
      .filter((a) => a.kind === 'background')
      .map((a) => ({
        id: String(a.sessionId || '').slice(0, 8),
        name: a.name || '',
        status: a.status || '실행 중',
        cwd: a.cwd || '',
      }));
  } catch {
    return [];
  }
}

/** 각 CLI 의 설치 패키지(2026-08-01 실측 — 전역 npm 목록에서 확인). */
export const INSTALL = {
  claude: { pkg: '@anthropic-ai/claude-code' },
  gemini: { pkg: '@google/gemini-cli' },
  codex: { pkg: '@openai/codex' },
};

export const installCommand = (id) => `npm install -g ${INSTALL[id].pkg}`;

/** 터미널 창을 띄워 명령을 실행한다(진행 상황을 사용자가 직접 본다). */
export function openTerminal(command) {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', 'cmd', '/k', command], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } else if (process.platform === 'darwin') {
    spawn('osascript', ['-e', `tell app "Terminal" to do script "${command}"`], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } else {
    spawn('x-terminal-emulator', ['-e', command], { detached: true, stdio: 'ignore' }).unref();
  }
  return command;
}

/** 로그인용 터미널 창을 띄운다(대화형 인증은 사람이 마쳐야 한다). */
export function openLoginTerminal(id) {
  const spec = LOGIN[id];
  if (!spec) throw new Error(`알 수 없는 프로바이더: ${id}`);
  openTerminal(spec.command);
  return { command: spec.command, guide: spec.guide };
}

/** CLI 설치용 터미널 창을 띄운다. */
export function openInstallTerminal(id) {
  if (!INSTALL[id]) throw new Error(`알 수 없는 프로바이더: ${id}`);
  const command = installCommand(id);
  openTerminal(command);
  return {
    command,
    guide: '설치가 끝나면 창을 닫고 상단 [진단]을 누르세요. 이후 로그인이 필요합니다.',
  };
}
