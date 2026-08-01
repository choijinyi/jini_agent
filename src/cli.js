import readline from 'node:readline';
import { loadConfig, apiKey, MODELS, DEFAULTS } from './config.js';
import { Ledger } from './agent/ledger.js';
import { PROVIDERS, runProvider, doctor } from './providers/index.js';

const HELP = `Jini Agent — 다중 AI 코딩 에이전트 (계정 로그인 방식)

사용법
  jini                      대화형 세션 (마스터=claude)
  jini "작업 지시"           1회 실행 후 종료
  jini run "작업 지시"       마스터 위임 파이프라인 (계획→병렬 실행→취합)
  jini ui                   창 앱 실행
  jini --to gemini "질문"    특정 프로바이더에 직접
  jini panel "질문"          3사 동시 질의 후 나란히 비교
  jini doctor               CLI 설치·인증 진단
  jini update               최신 버전으로 갱신
  jini bg "작업"             Claude Code 백그라운드 에이전트로 넘김
                            → 클로드 스마트폰 앱에서 보이고 이어서 조종 가능
  jini agents               백그라운드 에이전트 목록

프로바이더 (인증 = 각 CLI 의 계정 로그인 · API 키 불요)
  claude   오케스트레이션·코딩·심층추론 (마스터)
  gemini   심층리서치·리뷰
  codex    코드리뷰·구현 보조

플래그
  --to <provider>    이번 요청을 보낼 프로바이더
  --backend cli|api  cli(기본)=벤더 CLI · api=Anthropic API 키 직접
  --model <id>       프로바이더 모델 고정
  --yolo             (api 백엔드) 쓰기·실행 승인 생략
  --help

설정
  jini config                전체 설정 보기
  jini config <키> <값>       설정 변경 (예: jini config master gemini)
  jini config reset <키>      기본값으로 되돌리기

세션 명령
  /to <provider>  기본 대상 변경     /panel <질문>  3사 동시 질의
  /config  설정 보기·변경            /cost  토큰·비용 원장
  /doctor  진단                      /new   세션 새로 시작
  /exit    종료`;

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--yolo') flags.autoApprove = true;
    else if (a === '--no-defer') flags.deferTools = false;
    else if (a === '--no-context-edit') flags.contextEditing = false;
    else if (a === '--backend') flags.backend = argv[++i];
    else if (a === '--to') flags.to = argv[++i];
    else if (a === '--model') flags.model = argv[++i];
    else if (a === '--effort') flags.effort = argv[++i];
    else if (a === '--max-tokens') flags.maxTokens = Number(argv[++i]);
    else if (a === '-p' || a === '--prompt') rest.push(argv[++i]);
    else rest.push(a);
  }
  return { flags, prompt: rest.join(' ').trim() };
}

/** 설치본을 최신으로 올린다(설치 스크립트를 그대로 재사용 — 검증된 경로 하나만 유지). */
async function runUpdate() {
  const { spawn } = await import('node:child_process');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const script = path.join(root, process.platform === 'win32' ? 'install.ps1' : 'install.sh');

  const [cmd, args] =
    process.platform === 'win32'
      ? ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]]
      : ['bash', [script]];

  console.log(`갱신 중: ${root}`);
  const child = spawn(cmd, args, { stdio: 'inherit' });
  const code = await new Promise((res) => child.on('close', res));
  if (code !== 0) process.exitCode = code;
}

/**
 * jini config            전체 설정 보기
 * jini config <키>        값 하나 보기
 * jini config <키> <값>   저장
 * jini config reset <키>  기본값으로
 */
async function runConfig(args) {
  const { list, set, reset, userConfigPath, SCHEMA } = await import('./settings.js');

  if (args[0] === 'reset') {
    if (!args[1]) {
      console.error('사용법: jini config reset <키>');
      process.exitCode = 1;
      return;
    }
    try {
      const removed = reset(args[1]);
      console.log(removed ? `${args[1]} → 기본값으로 되돌림` : `${args[1]} 은 이미 기본값입니다`);
    } catch (e) {
      console.error(`\x1b[31m${e.message}\x1b[0m`);
      process.exitCode = 1;
    }
    return;
  }

  if (args.length >= 2) {
    try {
      const v = set(args[0], args.slice(1).join(' '));
      console.log(`${args[0]} = ${JSON.stringify(v)}  (저장: ${userConfigPath()})`);
    } catch (e) {
      console.error(`\x1b[31m${e.message}\x1b[0m`);
      process.exitCode = 1;
    }
    return;
  }

  const rows = list();
  if (args.length === 1) {
    const r = rows.find((x) => x.key === args[0]);
    if (!r) {
      console.error(`알 수 없는 설정 키: ${args[0]}`);
      process.exitCode = 1;
      return;
    }
    console.log(`${r.key} = ${JSON.stringify(r.value)}${r.isDefault ? '  (기본값)' : ''}`);
    if (r.choices) console.log(`  가능: ${r.choices.join(' | ')}`);
    return;
  }

  console.log(`설정  (파일: ${userConfigPath()})\n`);
  for (const scope of ['cli', 'both', 'api']) {
    const group = rows.filter((r) => r.scope === scope);
    if (!group.length) continue;
    const head = scope === 'cli' ? '계정 로그인 백엔드' : scope === 'api' ? 'API 백엔드 전용' : '공통';
    console.log(`\x1b[1m${head}\x1b[0m`);
    for (const r of group) {
      const mark = r.isDefault ? '\x1b[90m·\x1b[0m' : '\x1b[32m*\x1b[0m';
      const val = JSON.stringify(r.value);
      console.log(`  ${mark} ${r.key.padEnd(24)} ${val.padEnd(20)} ${r.label}`);
    }
    console.log();
  }
  console.log('\x1b[90m* = 직접 지정한 값 · · = 기본값\x1b[0m');
  console.log('\x1b[90m바꾸기: jini config <키> <값>   되돌리기: jini config reset <키>\x1b[0m');
  void SCHEMA;
}

/** Electron 창을 띄운다. 전역 설치가 아닌 로컬 electron 바이너리를 쓴다. */
async function launchUi() {
  const { spawn } = await import('node:child_process');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');

  let electronPath;
  try {
    ({ default: electronPath } = await import('electron'));
  } catch {
    console.error(
      'Electron 이 설치돼 있지 않습니다. 설치 폴더에서 실행하세요:\n  npm install --omit=dev'
    );
    process.exitCode = 1;
    return;
  }

  const child = spawn(electronPath, [appDir], { stdio: 'inherit', windowsHide: false });
  await new Promise((res) => child.on('close', res));
}

async function printDoctor() {
  const rows = await doctor();
  console.log('프로바이더 진단 (인증 = 본인 계정 로그인)');
  for (const r of rows) {
    const mark = r.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    const how = r.installed ? r.auth.detail : '미설치';
    console.log(`  ${mark} ${r.id.padEnd(7)} ${(r.version || '-').padEnd(24)} ${how}`);
    if (r.note) console.log(`      \x1b[33m${r.note}\x1b[0m`);
  }
  const needLogin = rows.filter((r) => r.installed && !r.auth.ok);
  if (needLogin.length) {
    console.log('\n로그인이 필요합니다 — 아래를 실행하세요:');
    for (const r of needLogin) console.log(`  ${r.login.command}   (${r.id})`);
  }
  const notInstalled = rows.filter((r) => !r.installed);
  if (notInstalled.length) {
    console.log(`\n미설치 ${notInstalled.length}종: ${notInstalled.map((r) => r.id).join(', ')}`);
  }
  return rows;
}

/** CLI 백엔드 1회 호출. 세션 ID 를 보관해 다음 턴에 이어붙인다. */
async function askProvider(state, id, prompt) {
  const cfg = state.cfg;
  const t0 = Date.now();
  const res = await runProvider(id, prompt, {
    cwd: cfg.cwd,
    model: cfg.providerModels?.[id] || undefined,
    session: state.sessions[id] || undefined,
  });
  if (res.session) state.sessions[id] = res.session;
  state.ledger.addExternal(res.model || `cli:${id}`, res.usage);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  return { ...res, secs };
}

export async function main(argv) {
  const { flags, prompt } = parseArgs(argv);
  if (flags.help) {
    console.log(HELP);
    return;
  }

  const words = prompt.split(/\s+/);
  const sub = words[0];

  if (sub === 'doctor') {
    await printDoctor();
    return;
  }

  if (sub === 'ui' || sub === 'app') {
    return launchUi();
  }

  if (sub === 'config') {
    return runConfig(words.slice(1));
  }

  if (sub === 'update') {
    return runUpdate();
  }

  if (sub === 'bg' || sub === 'agents') {
    const cfg3 = loadConfig(flags);
    const { startBackgroundClaude, listBackgroundAgents } = await import('./providers/index.js');
    if (sub === 'agents') {
      const rows = await listBackgroundAgents();
      if (!rows.length) {
        console.log('실행 중인 백그라운드 에이전트가 없습니다.');
        return;
      }
      for (const a of rows) console.log(`  ${a.id}  ${a.status.padEnd(10)} ${a.name}`);
      console.log('\n붙기: claude attach <id> · 중지: claude stop <id>');
      return;
    }
    const task = words.slice(1).join(' ');
    if (!task) {
      console.error('사용법: jini bg "작업 지시"');
      process.exitCode = 1;
      return;
    }
    try {
      const a = await startBackgroundClaude(task, {
        cwd: cfg3.cwd,
        claudeConfigDir: cfg3.claudeConfigDir || undefined,
        permissionMode: cfg3.bgPermissionMode || 'default',
      });
      console.log(`백그라운드 에이전트 시작: ${a.id}`);
      console.log('  클로드 스마트폰 앱·웹에서 이 세션이 보입니다(계정 로그인 기준).');
      console.log(`  이 터미널에서 붙기: ${a.attach}`);
      console.log(`  중지: ${a.stop}`);
    } catch (e) {
      console.error(`\x1b[31m[실패]\x1b[0m ${e.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (sub === 'run') {
    const cfg2 = loadConfig(flags);
    const ledger2 = new Ledger();
    const task = words.slice(1).join(' ');
    if (!task) {
      console.error('사용법: jini run "작업 지시"');
      process.exitCode = 1;
      return;
    }
    const { Pipeline } = await import('./pipeline/engine.js');
    const p = new Pipeline(cfg2, ledger2);
    p.on('plan:done', (d) =>
      console.log(
        `\x1b[90m계획 ${d.steps.length}단계 · ${d.batches.length}배치` +
          `${d.batches.some((b) => b.length > 1) ? ' (병렬 포함)' : ''}\x1b[0m`
      )
    );
    p.on('step:start', (d) => console.log(`\x1b[90m  · ${d.to} 시작\x1b[0m`));
    p.on('step:done', (d) => console.log(`\x1b[90m  · ${d.provider} 완료 (${(d.ms / 1000).toFixed(1)}s)\x1b[0m`));
    p.on('step:error', (d) => console.error(`\x1b[31m  · ${d.to} 실패: ${d.error}\x1b[0m`));
    try {
      const out = await p.run(task);
      console.log(`\n${out.final}`);
    } catch (e) {
      console.error(`\x1b[31m[실패]\x1b[0m ${e.message}`);
      process.exitCode = 1;
    }
    console.error(`\x1b[90m${ledger2.format()}\x1b[0m`);
    return;
  }

  const cfg = loadConfig(flags);
  const ledger = new Ledger();
  const state = { cfg, ledger, sessions: {}, target: flags.to || cfg.master };

  if (cfg.backend === 'api') {
    // 키 방식 경로 — 프롬프트 캐싱·도구 지연 로딩·컨텍스트 편집을 쓸 수 있는 유일한 경로.
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const { createSession, runTurn } = await import('./agent/loop.js');
    const client = new Anthropic({ apiKey: apiKey() });
    const session = createSession(cfg, client, ledger);
    if (prompt) {
      await runTurn(session, prompt, async () => cfg.autoApprove);
      console.error(`\x1b[90m${ledger.format()}\x1b[0m`);
      return;
    }
    return replApi(cfg, ledger, session);
  }

  if (!PROVIDERS[state.target]) {
    console.error(`알 수 없는 프로바이더: ${state.target} (${Object.keys(PROVIDERS).join(', ')})`);
    process.exitCode = 1;
    return;
  }

  if (sub === 'panel') {
    const q = words.slice(1).join(' ');
    if (!q) {
      console.error('사용법: jini panel "질문"');
      process.exitCode = 1;
      return;
    }
    await panel(state, q);
    console.error(`\x1b[90m${ledger.format()}\x1b[0m`);
    return;
  }

  if (prompt) {
    const r = await askProvider(state, state.target, prompt);
    console.log(r.text);
    console.error(`\x1b[90m[${r.provider} ${r.secs}s] ${ledger.format()}\x1b[0m`);
    return;
  }

  await replCli(state);
}

/** 3사 동시 질의 — 같은 질문을 병렬로 던지고 나란히 출력한다. */
async function panel(state, question) {
  const ids = Object.keys(PROVIDERS);
  console.log(`\x1b[90m3사 동시 질의: ${ids.join(' · ')}\x1b[0m\n`);
  const results = await Promise.all(
    ids.map((id) =>
      askProvider(state, id, question).catch((e) => ({ provider: id, error: e.message }))
    )
  );
  for (const r of results) {
    console.log(`\x1b[1m── ${r.provider}${r.secs ? ` (${r.secs}s)` : ''} ──\x1b[0m`);
    console.log(r.error ? `\x1b[31m실패: ${r.error}\x1b[0m` : r.text);
    console.log();
  }
}

async function replCli(state) {
  const { cfg, ledger } = state;
  console.log(
    `\x1b[1mJini Agent\x1b[0m  backend=cli · 마스터=${cfg.master} · 대상=${state.target}\n` +
      `${cfg.cwd}\n/help 로 명령 목록.\n`
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));

  for (;;) {
    const line = (await ask(`\x1b[36m${state.target} › \x1b[0m`)).trim();
    if (!line) continue;

    if (line.startsWith('/')) {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      const arg = rest.join(' ');
      if (cmd === 'exit' || cmd === 'quit') break;
      if (cmd === 'help') { console.log(HELP); continue; }
      if (cmd === 'cost') { console.log(ledger.format()); continue; }
      if (cmd === 'doctor') { await printDoctor(); continue; }
      if (cmd === 'config') {
        await runConfig(rest);
        if (rest.length >= 2 || rest[0] === 'reset') {
          Object.assign(cfg, loadConfig({}));
          state.target = cfg.master;
          console.log('\x1b[90m설정을 다시 읽었습니다.\x1b[0m');
        }
        continue;
      }
      if (cmd === 'new') { state.sessions = {}; console.log('세션 새로 시작(원장은 유지).'); continue; }
      if (cmd === 'to') {
        if (!PROVIDERS[arg]) { console.log(`사용 가능: ${Object.keys(PROVIDERS).join(', ')}`); continue; }
        state.target = arg;
        console.log(`대상 → ${arg}`);
        continue;
      }
      if (cmd === 'panel') {
        if (!arg) { console.log('사용법: /panel <질문>'); continue; }
        try { await panel(state, arg); } catch (e) { console.error(`\x1b[31m[오류]\x1b[0m ${e.message}`); }
        continue;
      }
      console.log(`알 수 없는 명령: /${cmd}`);
      continue;
    }

    try {
      const r = await askProvider(state, state.target, line);
      console.log(r.text);
      console.log(`\x1b[90m[${r.provider} ${r.secs}s] ${ledger.format()}\x1b[0m`);
    } catch (e) {
      console.error(`\x1b[31m[오류]\x1b[0m ${e.message}`);
    }
  }
  rl.close();
  console.log(ledger.format());
}

/** api 백엔드 REPL(M1 경로 유지). */
async function replApi(cfg, ledger, session) {
  const { runTurn } = await import('./agent/loop.js');
  console.log(
    `\x1b[1mJini Agent\x1b[0m  backend=api · ${cfg.model} · effort=${cfg.effort}\n${cfg.cwd}\n`
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));
  const approve = async (name, input) => {
    const s = JSON.stringify(input);
    const a = await ask(`\x1b[33m[승인] ${name} ${s.slice(0, 200)} (y/N) \x1b[0m`);
    return /^y(es)?$/i.test(a.trim());
  };

  for (;;) {
    const line = (await ask('\x1b[36m› \x1b[0m')).trim();
    if (!line) continue;
    if (line === '/exit' || line === '/quit') break;
    if (line === '/cost') { console.log(ledger.format()); continue; }
    if (line === '/clear') { session.messages.length = 0; console.log('대화 초기화.'); continue; }
    if (line === '/help') { console.log(HELP); continue; }
    if (line === '/model') { console.log(Object.keys(MODELS).join(', ')); continue; }
    try {
      await runTurn(session, line, approve);
      console.log(`\x1b[90m${ledger.format()}\x1b[0m`);
    } catch (e) {
      console.error(`\x1b[31m[오류]\x1b[0m ${e.message}`);
    }
  }
  rl.close();
  console.log(ledger.format());
}

export { DEFAULTS };
