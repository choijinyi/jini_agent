/**
 * API 키 없이 도는 자기검증. `npm run selftest`
 * 네트워크를 타는 경로(count_tokens, 모델 호출)는 제외한다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execTool } from './tools/exec.js';
import { buildTools, CORE_TOOLS, NEEDS_APPROVAL } from './tools/registry.js';
import { applyCacheBreakpoints } from './agent/loop.js';
import { pickEffort } from './agent/router.js';
import { Ledger } from './agent/ledger.js';
import { DEFAULTS } from './config.js';
import { buildSystem } from './agent/system.js';
import {
  PROVIDERS,
  parseClaude,
  parseGemini,
  parseCodex,
  checkAuth,
  LOGIN,
  INSTALL,
  installCommand,
  parseBackgroundId,
  claudeEnv,
  claudeProfileInfo,
} from './providers/index.js';
import { Pipeline, parsePlan, toBatches, composeStepPrompt } from './pipeline/engine.js';
import { SCHEMA, coerce, list as settingsList } from './settings.js';
import { createRemoteServer, tokenEquals, genToken, buildUrl } from './remote/server.js';
import { loadAllowlist, pruneExtraneous, pinNpxVersion, writePluginManifest, checkUpstream, SAFE_NAME, applyBodyPolicy, scanBodyPolicy, PENDING_JUDGMENT, POLICY_GROUPS, buildModifications } from './tools/skills-install.js';
import { skillsPluginDir } from './providers/index.js';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verify as verifySkills, scanFloating } from './tools/skills-verify.js';
import {
  skillTools,
  loadSkills,
  parseFrontmatter,
  skillBody,
  manifestNames,
  rewriteVendorCommand,
  SAFETY,
  SKILLS_ROOT,
} from './tools/skills.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jini-'));
const cfg = { ...DEFAULTS, cwd: tmp, model: 'claude-opus-5' };
let passed = 0;
const fail = (name, e) => {
  console.error(`  FAIL ${name}: ${e.message}`);
  process.exitCode = 1;
};

/**
 * 비동기 테스트가 실패하면 이전 구현은 unhandled rejection 으로 전체 실행이
 * 중단되고 FAIL 줄조차 남지 않았다 — CSO 검수 §3(중대). .catch 로 흡수한다.
 */
const check = (name, fn) => {
  let r;
  try {
    r = fn();
  } catch (e) {
    fail(name, e);
    return Promise.resolve();
  }
  if (r instanceof Promise) {
    return r.then(
      () => { console.log(`  ok  ${name}`); passed++; },
      (e) => fail(name, e)
    );
  }
  console.log(`  ok  ${name}`);
  passed++;
  return Promise.resolve();
};

fs.mkdirSync(path.join(tmp, 'src'));
fs.writeFileSync(path.join(tmp, 'src', 'a.js'), 'const x = 1;\nconst y = 2;\nexport { x, y };\n');
fs.writeFileSync(path.join(tmp, 'README.md'), '# demo\nhello\n');

await check('write + read', async () => {
  await execTool('write', { path: 'src/b.js', content: 'line1\nline2\n' }, cfg, {});
  const out = await execTool('read', { path: 'src/b.js' }, cfg, {});
  assert.match(out, /1\tline1/);
});

await check('read 재호출은 포인터만 반환(중복 토큰 제거)', async () => {
  const second = await execTool('read', { path: 'src/b.js' }, cfg, {});
  assert.match(second, /unchanged since earlier read/);
});

await check('edit 유일성 강제', async () => {
  await execTool('edit', { path: 'src/b.js', old: 'line1', new: 'LINE1' }, cfg, {});
  const out = await execTool('read', { path: 'src/b.js' }, cfg, {});
  assert.match(out, /LINE1/);
  await assert.rejects(() => execTool('edit', { path: 'src/b.js', old: 'nope', new: 'x' }, cfg, {}));
});

await check('grep', async () => {
  const out = await execTool('grep', { pattern: 'const y', glob: '**/*.js' }, cfg, {});
  assert.match(out, /a\.js:2/);
});

await check('glob', async () => {
  const out = await execTool('glob', { pattern: 'src/**/*.js' }, cfg, {});
  assert.match(out, /src\/a\.js/);
});

await check('경로 탈출 거부 — 가드가 거부한 것인지 메시지로 확정', async () => {
  // 존재하지 않는 표적을 쓰면 ENOENT 로도 통과해 무의미 통과가 된다 — CSO 검수 §2(중대).
  // 실존 파일을 표적으로 삼고, 에러 메시지가 가드의 것인지까지 확인한다.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jini-esc-'));
  const victim = path.join(outside, 'real.txt');
  fs.writeFileSync(victim, 'REAL\n');
  const rel = path.relative(tmp, victim).split(path.sep).join('/');
  for (const p of [rel, victim, `${victim.replace(/\\/g, '/')}`]) {
    await assert.rejects(() => execTool('read', { path: p }, cfg, {}), /작업 루트 밖 경로 거부/);
  }
  fs.rmSync(outside, { recursive: true, force: true });
});

await check('도구 결과 상한', async () => {
  const big = 'x'.repeat(50_000);
  await execTool('write', { path: 'big.txt', content: big }, cfg, {});
  const out = await execTool('read', { path: 'big.txt', limit: 1 }, cfg, {});
  assert.ok(out.length <= cfg.toolResultCap + 200, `길이 ${out.length}`);
});

await check('지연 로딩 도구 구성', () => {
  const tools = buildTools(cfg);
  assert.equal(tools[0].type, 'tool_search_tool_regex_20251119');
  assert.ok(tools.some((t) => t.defer_loading === true), '지연 도구 없음');
  assert.ok(tools.some((t) => t.name === 'read' && !t.defer_loading), '핵심 도구가 지연됨');
});

await check('캐시 브레이크포인트는 최대 2개(직전+현재 user 턴)', () => {
  const msgs = [];
  for (let i = 0; i < 5; i++) {
    msgs.push({ role: 'user', content: [{ type: 'text', text: `u${i}` }] });
    msgs.push({ role: 'assistant', content: [{ type: 'text', text: `a${i}` }] });
  }
  applyCacheBreakpoints(msgs);
  const marked = msgs.flatMap((m) => m.content).filter((b) => b.cache_control).length;
  assert.equal(marked, 2);
});

await check('system 프리픽스에 캐시 마커 1개', () => {
  const blocks = buildSystem(cfg);
  assert.equal(blocks.filter((b) => b.cache_control).length, 1);
  assert.ok(blocks[blocks.length - 1].cache_control);
});

await check('시스템 프롬프트가 동적 값을 포함하지 않음(캐시 무효화 방지)', () => {
  const a = JSON.stringify(buildSystem(cfg));
  const b = JSON.stringify(buildSystem(cfg));
  assert.equal(a, b);
});

await check('원장 비용 산식', () => {
  const l = new Ledger();
  l.add('claude-opus-5', {
    input_tokens: 1_000_000,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
  assert.equal(l.totals().cost.toFixed(2), '5.00');
  l.add('claude-opus-5', {
    input_tokens: 0,
    output_tokens: 1_000_000,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
  assert.equal(l.totals().cost.toFixed(2), '30.00');
});

await check('핵심 도구 스키마 무결성', () => {
  for (const t of CORE_TOOLS) {
    assert.ok(t.name && t.description && t.input_schema.type === 'object', t.name);
    assert.ok(t.description.length < 120, `${t.name} 설명이 깁니다(프리픽스 낭비)`);
  }
});

await check('회귀 §9: effort 강등이 입력 길이를 실제로 본다', () => {
  const c = { ...cfg, effort: 'medium', shortInputChars: 280 };
  const base = { turnIndex: 0, lastUsedTools: false };
  assert.equal(pickEffort(c, { ...base, inputLength: 20 }), 'low', '짧은 입력은 강등');
  assert.equal(pickEffort(c, { ...base, inputLength: 5000 }), 'medium', '긴 입력은 유지');
  assert.equal(
    pickEffort(c, { turnIndex: 3, lastUsedTools: false, inputLength: 20 }),
    'medium',
    '첫 턴이 아니면 유지'
  );
  assert.equal(
    pickEffort(c, { turnIndex: 0, lastUsedTools: true, inputLength: 20 }),
    'medium',
    '직전 도구 사용이면 유지'
  );
  assert.equal(pickEffort({ ...c, autoEffort: false }, { ...base, inputLength: 20 }), 'medium');
});

// ── 회귀: reviewer-gemini 가 확증한 결함 2종 (2026-08-01) ────────

await check('회귀 ②-2: git 도구 셸 메타문자 주입 차단', async () => {
  await assert.rejects(
    () => execTool('git', { args: 'status && echo INJECTED_MARKER' }, cfg, {}),
    /허용되지 않는 문자/
  );
  // 'log;' 는 하위명령 검사에서, '&&' 는 문자 화이트리스트에서 걸린다 — 어느 쪽이든 차단.
  await assert.rejects(
    () => execTool('git', { args: 'log; rm -rf /' }, cfg, {}),
    /허용되지 않는 문자|읽기 전용/
  );
  await assert.rejects(() => execTool('git', { args: 'push origin main' }, cfg, {}), /읽기 전용/);
});

await check('회귀 ②-1: 심링크·정션을 통한 루트 탈출 차단', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jini-out-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP_SECRET\n');
  let made = false;
  try {
    fs.symlinkSync(outside, path.join(tmp, 'link'), 'junction');
    made = true;
  } catch {
    /* 권한 없으면 이 검증은 건너뛴다 */
  }
  if (made) {
    await assert.rejects(
      () => execTool('read', { path: 'link/secret.txt' }, cfg, {}),
      /작업 루트 밖/
    );
    fs.rmSync(path.join(tmp, 'link'), { recursive: true, force: true });
  }
  fs.rmSync(outside, { recursive: true, force: true });
});

await check('회귀 ②-3: git 이 승인 게이트에 포함됨', () => {
  assert.ok(NEEDS_APPROVAL.has('git'));
  for (const t of ['write', 'edit', 'bash']) assert.ok(NEEDS_APPROVAL.has(t), t);
});

// ── 프로바이더 계층(계정 로그인 CLI) ─────────────────────────────
// 픽스처는 2026-08-01 각 CLI 실행에서 실제로 관측한 출력이다(합성 아님).

await check('프로바이더 argv 는 플래그만 — 프롬프트가 argv 에 실리지 않음', () => {
  for (const spec of Object.values(PROVIDERS)) {
    const args = spec.buildArgs({});
    assert.ok(!args.some((a) => a.includes('Reply')), `${spec.id} argv 오염`);
  }
  assert.deepEqual(PROVIDERS.claude.buildArgs({}), ['-p', '--output-format', 'json']);
  assert.deepEqual(PROVIDERS.gemini.buildArgs({}), ['-p', '', '-o', 'json', '--yolo']);
  assert.deepEqual(PROVIDERS.codex.buildArgs({}), ['exec', '-', '--json']);
});

await check('argv 토큰 화이트리스트가 주입 문자를 거부', () => {
  assert.throws(() => PROVIDERS.claude.buildArgs({ model: 'a && rm -rf /' }));
  assert.throws(() => PROVIDERS.gemini.buildArgs({ session: '"; evil' }));
  assert.deepEqual(PROVIDERS.claude.buildArgs({ model: 'claude-opus-5' }).slice(-2), [
    '--model',
    'claude-opus-5',
  ]);
});

await check('claude 출력 파싱(실측 픽스처)', () => {
  const fixture = JSON.stringify({
    is_error: false,
    session_id: '8c8956d9-9922-451b-9079-6c16ec1b07aa',
    total_cost_usd: 0.3808285,
    usage: {
      input_tokens: 2,
      output_tokens: 4,
      cache_read_input_tokens: 20817,
      cache_creation_input_tokens: 37031,
    },
    modelUsage: { 'claude-opus-5[1m]': {} },
    result: 'OK',
  });
  const r = parseClaude(fixture);
  assert.equal(r.text, 'OK');
  assert.equal(r.session, '8c8956d9-9922-451b-9079-6c16ec1b07aa');
  assert.equal(r.usage.cacheRead, 20817);
  assert.equal(r.usage.costUSD, 0.3808285);
});

await check('gemini 출력 파싱 — 경고문 접두를 건너뛴다(실측 픽스처)', () => {
  const noisy =
    'Warning: True color (24-bit) support not detected.\nYOLO mode is enabled.\n' +
    JSON.stringify({
      session_id: 'b71deeda-5417-40fe-a2bc-46b54f5f7955',
      response: 'OK',
      stats: {
        models: {
          'gemini-3.1-flash-lite': { tokens: { input: 2508, candidates: 43, cached: 0 } },
        },
      },
    });
  const r = parseGemini(noisy);
  assert.equal(r.text, 'OK');
  assert.equal(r.usage.input, 2508);
  assert.equal(r.usage.output, 43);
  assert.equal(r.model, 'gemini-3.1-flash-lite');
});

await check('gemini 오류 객체는 예외로 승격', () => {
  const err = JSON.stringify({ error: { message: 'auth 없음', code: 41 } });
  assert.throws(() => parseGemini(err), /auth 없음/);
});

await check('codex JSONL 파싱(실측 픽스처)', () => {
  const jsonl = [
    '{"type":"thread.started","thread_id":"019fbae1-f087-7cf2-87e3-32c2d2b28287"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK2"}}',
    '{"type":"turn.completed","usage":{"input_tokens":20120,"cached_input_tokens":11008,"cache_write_input_tokens":0,"output_tokens":6}}',
  ].join('\n');
  const r = parseCodex(jsonl);
  assert.equal(r.text, 'OK2');
  assert.equal(r.session, '019fbae1-f087-7cf2-87e3-32c2d2b28287');
  assert.equal(r.usage.input, 20120);
  assert.equal(r.usage.cacheRead, 11008);
});

await check('원장: CLI 가 준 실제 비용이 단가 추정보다 우선', () => {
  const l = new Ledger();
  l.addExternal('claude-opus-5', { input: 2, output: 4, costUSD: 0.38 });
  assert.equal(l.totals().cost.toFixed(2), '0.38');
  l.addExternal('cli:gemini', { input: 2508, output: 43 });
  assert.equal(l.totals().cost.toFixed(2), '0.38'); // 단가 미상 → 비용 0 가산
  assert.equal(l.totals().input, 2510);
});

// ── 로그인 상태 판정 (가짜 홈으로 검증 — 남의 PC 에서도 옳게 판정되어야 한다) ──

await check('로그인 판정 — 계정 파일 있으면 account', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jini-home-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/.credentials.json'), '{}');
  const a = checkAuth('claude', { home, env: {} });
  assert.equal(a.ok, true);
  assert.equal(a.method, 'account');
  fs.rmSync(home, { recursive: true, force: true });
});

await check('로그인 판정 — 아무 것도 없으면 로그인 필요', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jini-home-'));
  for (const id of ['claude', 'gemini', 'codex']) {
    const a = checkAuth(id, { home, env: {} });
    assert.equal(a.ok, false, id);
    assert.equal(a.method, 'none', id);
  }
  fs.rmSync(home, { recursive: true, force: true });
});

await check('로그인 판정 — API 키만 있으면 api-key 로 구분', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jini-home-'));
  const a = checkAuth('claude', { home, env: { ANTHROPIC_API_KEY: 'sk-x' } });
  assert.equal(a.method, 'api-key');
  assert.equal(a.ok, true);
  fs.rmSync(home, { recursive: true, force: true });
});

await check('로그인 판정 — gemini 는 설정이 키 방식이면 계정 파일이 있어도 api-key', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jini-home-'));
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gemini/google_accounts.json'), '{}');
  fs.writeFileSync(
    path.join(home, '.gemini/settings.json'),
    JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } })
  );
  const keyed = checkAuth('gemini', { home, env: { GEMINI_API_KEY: 'x' } });
  assert.equal(keyed.method, 'api-key');

  fs.writeFileSync(
    path.join(home, '.gemini/settings.json'),
    JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } })
  );
  const acct = checkAuth('gemini', { home, env: { GEMINI_API_KEY: 'x' } });
  assert.equal(acct.method, 'account', 'oauth 선택 시 계정 우선');
  fs.rmSync(home, { recursive: true, force: true });
});

await check('claude 자식 환경은 상속된 CLAUDE_CONFIG_DIR 을 제거한다(폰 앱 연동 프로필 고정)', () => {
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = 'C:/some/isolated/profile';
  try {
    assert.equal(claudeEnv().CLAUDE_CONFIG_DIR, undefined, '상속값이 남아 있으면 안 됨');
    assert.equal(claudeEnv('C:/override').CLAUDE_CONFIG_DIR, 'C:/override', '명시 지정은 존중');
    assert.ok(claudeEnv().PATH !== undefined, '나머지 환경은 유지');
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
  }
});

await check('claude 프로필 진단 — 원격 제어 켜짐 여부를 읽는다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jini-prof-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({ remoteControlAtStartup: true }));
  const on = claudeProfileInfo({ home, env: {} });
  assert.equal(on.remoteControl, true);
  assert.equal(on.inherited, null);

  fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({}));
  assert.equal(claudeProfileInfo({ home, env: {} }).remoteControl, false);
  assert.equal(
    claudeProfileInfo({ home, env: { CLAUDE_CONFIG_DIR: 'X' } }).inherited,
    'X',
    '상속값을 보고해야 함'
  );
  fs.rmSync(home, { recursive: true, force: true });
});

await check('백그라운드 에이전트 id 파싱(실측 출력 형식)', () => {
  const real = [
    'Starting background service…',
    'backgrounded · 405fd68f',
    '  claude agents             list sessions',
    '  claude attach 405fd68f    open in this terminal',
  ].join('\n');
  assert.equal(parseBackgroundId(real), '405fd68f');
  assert.equal(parseBackgroundId('backgrounded - abc123def'), 'abc123def');
  assert.throws(() => parseBackgroundId('아무 출력'), /찾지 못했습니다/);
});

await check('설치 명령이 프로바이더마다 정의돼 있다', () => {
  assert.equal(installCommand('claude'), 'npm install -g @anthropic-ai/claude-code');
  assert.equal(installCommand('gemini'), 'npm install -g @google/gemini-cli');
  assert.equal(installCommand('codex'), 'npm install -g @openai/codex');
  for (const id of Object.keys(PROVIDERS)) assert.ok(INSTALL[id]?.pkg, id);
});

await check('로그인 안내 명령이 프로바이더마다 정의돼 있다', () => {
  for (const id of ['claude', 'gemini', 'codex']) {
    assert.ok(LOGIN[id].command, id);
    assert.ok(LOGIN[id].guide, id);
    assert.ok(LOGIN[id].files.length, id);
  }
  assert.equal(LOGIN.claude.command, 'claude auth login');
  assert.equal(LOGIN.codex.command, 'codex login');
});

// ── 설정(/config) ────────────────────────────────────────────────

await check('설정 스키마 — 모든 키에 라벨·타입·범위가 있다', () => {
  for (const [key, s] of Object.entries(SCHEMA)) {
    assert.ok(s.label, `${key} 라벨 없음`);
    assert.ok(['bool', 'int', 'choice', 'string'].includes(s.type), `${key} 타입`);
    assert.ok(['cli', 'api', 'both'].includes(s.scope), `${key} 스코프`);
    if (s.type === 'choice') assert.ok(s.choices?.length, `${key} 선택지 없음`);
  }
});

await check('설정 값 변환·검증 — 어긋난 값은 예외', () => {
  assert.equal(coerce('autoApprove', 'true'), true);
  assert.equal(coerce('autoApprove', 'off'), false);
  assert.equal(coerce('readWindow', '300'), 300);
  assert.equal(coerce('master', 'gemini'), 'gemini');
  assert.throws(() => coerce('master', 'gpt5'), /중 하나/);
  assert.throws(() => coerce('readWindow', '2.5'), /정수/);
  assert.throws(() => coerce('readWindow', '10'), /최소/);
  assert.throws(() => coerce('readWindow', '99999'), /최대/);
  assert.throws(() => coerce('autoApprove', '아무거나'), /true\/false/);
  assert.throws(() => coerce('없는키', 'x'), /알 수 없는 설정 키/);
});

await check('설정 목록 — 기본값 여부와 스코프가 함께 나온다', () => {
  const rows = settingsList();
  const master = rows.find((r) => r.key === 'master');
  assert.equal(master.value, 'claude');
  assert.equal(master.scope, 'cli');
  assert.equal(typeof master.isDefault, 'boolean');
  assert.ok(rows.some((r) => r.key === 'providerModels.claude'), '점 표기 키 누락');
  assert.ok(rows.length >= 10);
});

// ── 리모트 컨트롤 (실제 서버를 띄워 인증을 검증) ─────────────────

await check('리모트: 토큰 없이는 서버가 아예 뜨지 않는다', () => {
  assert.throws(() => createRemoteServer({ token: '', runTask: async () => {} }), /토큰이 없습니다/);
});

await check('리모트: 상수시간 토큰 비교', () => {
  assert.equal(tokenEquals('abc', 'abc'), true);
  assert.equal(tokenEquals('abc', 'abd'), false);
  assert.equal(tokenEquals('abc', 'abcd'), false);
  assert.equal(tokenEquals('', ''), true);
  assert.equal(tokenEquals(null, 'x'), false);
  assert.equal(genToken().length, 32);
});

await check('리모트: 틀린 토큰은 401, 맞으면 200 · 작업이 실행된다', async () => {
  const token = genToken();
  const port = 8900 + Math.floor(Math.random() * 90);
  let ran = null;
  const srv = createRemoteServer({
    token,
    port,
    bind: 'localhost',
    runTask: async (task, emit) => {
      ran = task;
      emit('run:done', { final: '완료' });
    },
  });
  await srv.start();
  try {
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/`)).status, 401, '토큰 없음은 401');
    assert.equal((await fetch(`${base}/?t=wrong`)).status, 401, '틀린 토큰은 401');

    const page = await fetch(`${base}/?t=${token}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Jini/);

    const run = await fetch(`${base}/run?t=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: '원격 작업' }),
    });
    assert.equal(run.status, 202);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(ran, '원격 작업', '작업이 실행되지 않음');

    const empty = await fetch(`${base}/run?t=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: '  ' }),
    });
    assert.equal(empty.status, 400, '빈 작업은 400');
  } finally {
    await srv.stop();
  }
});

await check('리모트: 폰 홈 화면 설치(PWA) 자산이 토큰 없이도 제공된다', async () => {
  const token = genToken();
  const port = 9100 + Math.floor(Math.random() * 90);
  const srv = createRemoteServer({ token, port, bind: 'localhost', runTask: async () => {} });
  await srv.start();
  try {
    const base = `http://127.0.0.1:${port}`;
    const man = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(man.status, 200, '매니페스트는 토큰 없이 200');
    const j = await man.json();
    assert.equal(j.display, 'standalone');
    assert.ok(j.icons.some((i) => i.sizes === '512x512'));

    for (const p of ['/sw.js', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png']) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, `${p} 200 이어야 함`);
    }
    // 설치 자산을 열어줘도 실행 경로는 여전히 잠겨 있어야 한다
    assert.equal((await fetch(`${base}/run`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(`${base}/`)).status, 401);
  } finally {
    await srv.stop();
  }
});

await check('리모트: 접속 주소는 bind 에 따라 달라진다', () => {
  const local = buildUrl({ bind: 'localhost', port: 8765, token: 'T' });
  assert.equal(local, 'http://127.0.0.1:8765/?t=T');
  const lan = buildUrl({ bind: 'lan', port: 9000, token: 'T' });
  assert.match(lan, /^http:\/\/[0-9.]+:9000\/\?t=T$/);
});

// ── 파이프라인 엔진 (네트워크 없이 주입된 호출자로 검증) ─────────

await check('계획 파싱 — 형식 위반은 예외로 승격', () => {
  const ok = parsePlan('{"steps":[{"id":"s1","to":"claude","prompt":"do","dependsOn":[]}]}');
  assert.equal(ok.length, 1);
  assert.deepEqual(ok[0].dependsOn, []);
  // 앞뒤 잡담이 섞여도 첫 { ~ 마지막 } 로 복구한다
  assert.equal(parsePlan('설명\n{"steps":[{"id":"a","to":"gemini","prompt":"x"}]}\n끝')[0].id, 'a');
  assert.throws(() => parsePlan('no json'), /JSON 을 찾지 못/);
  assert.throws(() => parsePlan('{"steps":[]}'), /비어 있/);
  assert.throws(() => parsePlan('{"steps":[{"id":"a","to":"gpt5","prompt":"x"}]}'), /알 수 없는 프로바이더/);
  assert.throws(
    () => parsePlan('{"steps":[{"id":"a","to":"claude","prompt":"x"},{"id":"a","to":"claude","prompt":"y"}]}'),
    /중복 step.id/
  );
  assert.throws(
    () => parsePlan('{"steps":[{"id":"a","to":"claude","prompt":"x","dependsOn":["zz"]}]}'),
    /알 수 없는 의존/
  );
});

await check('배치 분할 — 독립 단계는 같은 배치(병렬), 순환은 예외', () => {
  const steps = parsePlan(
    JSON.stringify({
      steps: [
        { id: 'a', to: 'gemini', prompt: 'r1', dependsOn: [] },
        { id: 'b', to: 'codex', prompt: 'r2', dependsOn: [] },
        { id: 'c', to: 'claude', prompt: 'merge', dependsOn: ['a', 'b'] },
      ],
    })
  );
  const batches = toBatches(steps);
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[0].map((s) => s.id).sort(), ['a', 'b']);
  assert.deepEqual(batches[1].map((s) => s.id), ['c']);

  const cyclic = [
    { id: 'x', to: 'claude', prompt: 'p', dependsOn: ['y'] },
    { id: 'y', to: 'claude', prompt: 'p', dependsOn: ['x'] },
  ];
  assert.throws(() => toBatches(cyclic), /순환 의존/);
});

await check('의존 산출물이 다음 단계 프롬프트에 주입된다', () => {
  const step = { id: 'c', to: 'claude', prompt: '합쳐라', dependsOn: ['a'] };
  const out = composeStepPrompt(step, { a: { id: 'a', provider: 'gemini', text: '리서치 결과' } });
  assert.match(out, /<result from="gemini" step="a">/);
  assert.match(out, /리서치 결과/);
  assert.match(out, /합쳐라$/);
  assert.equal(composeStepPrompt({ ...step, dependsOn: [] }, {}), '합쳐라');
});

await check('파이프라인 실행 — 독립 단계가 실제로 병렬로 돈다', async () => {
  const plan = JSON.stringify({
    steps: [
      { id: 'a', to: 'gemini', prompt: 'r1', dependsOn: [] },
      { id: 'b', to: 'codex', prompt: 'r2', dependsOn: [] },
      { id: 'c', to: 'claude', prompt: 'merge', dependsOn: ['a', 'b'] },
    ],
  });
  let live = 0;
  let maxLive = 0;
  const seen = [];
  const call = async (id, prompt) => {
    live++;
    maxLive = Math.max(maxLive, live);
    seen.push(id);
    await new Promise((r) => setTimeout(r, 15));
    live--;
    if (prompt.startsWith('You are the master orchestrator of a multi-agent')) {
      return { text: plan, usage: { input: 1, output: 1 } };
    }
    if (prompt.startsWith('You are the master orchestrator. Below are')) {
      return { text: '최종 취합', usage: { input: 1, output: 1 } };
    }
    return { text: `${id} 산출물`, usage: { input: 1, output: 1 } };
  };
  const led = new Ledger();
  const p = new Pipeline({ cwd: tmp, master: 'claude' }, led, call);
  const events = [];
  for (const e of ['plan:done', 'batch:start', 'step:done', 'run:done']) {
    p.on(e, (d) => events.push([e, d]));
  }
  const out = await p.run('작업');
  assert.equal(out.final, '최종 취합');
  assert.equal(maxLive, 2, `병렬도 2 여야 함(실측 ${maxLive})`);
  assert.equal(events.filter(([e]) => e === 'step:done').length, 3);
  assert.equal(led.totals().calls, 5); // 계획 1 + 단계 3 + 취합 1
});

await check('마스터 세션만 이어붙인다(단계 호출은 새 세션 — 병렬 충돌 방지)', async () => {
  const plan = JSON.stringify({
    steps: [
      { id: 'a', to: 'claude', prompt: 'x', dependsOn: [] },
      { id: 'b', to: 'gemini', prompt: 'y', dependsOn: [] },
    ],
  });
  const seen = [];
  const call = async (id, prompt, meta) => {
    seen.push({ id, session: meta?.session ?? null, kind: prompt.slice(0, 24) });
    if (prompt.startsWith('You are the master orchestrator of a multi-agent')) {
      return { text: plan, session: 'SID-1', usage: {} };
    }
    if (prompt.startsWith('You are the master orchestrator. Below are')) {
      return { text: '취합', session: 'SID-1', usage: {} };
    }
    return { text: 'ok', session: 'STEP-SID', usage: {} };
  };
  const store = {};
  const p = new Pipeline({ cwd: tmp, master: 'claude' }, new Ledger(), call, store);
  await p.run('작업');

  const planCall = seen[0];
  const synth = seen[seen.length - 1];
  assert.equal(planCall.session, null, '첫 계획은 세션 없음');
  assert.equal(synth.session, 'SID-1', '취합은 계획 세션을 이어받아야 함');
  const stepCalls = seen.filter((s) => !s.kind.startsWith('You are the master'));
  assert.ok(stepCalls.length >= 2);
  for (const s of stepCalls) assert.equal(s.session, null, '단계 호출은 세션을 물지 않는다');
  assert.equal(store.claude, 'SID-1', '마스터 세션이 보관함에 남아야 함');

  // 두 번째 턴은 처음부터 이어붙는다
  seen.length = 0;
  await p.run('다음 작업');
  assert.equal(seen[0].session, 'SID-1', '다음 턴 계획이 세션을 이어받지 않음');
});

await check('단일 단계는 취합 호출을 생략한다(왕복 절약)', async () => {
  const plan = JSON.stringify({ steps: [{ id: 'only', to: 'claude', prompt: 'x', dependsOn: [] }] });
  const call = async (id, prompt) =>
    prompt.startsWith('You are the master orchestrator of a multi-agent')
      ? { text: plan, usage: {} }
      : { text: '단일 답', usage: {} };
  const led = new Ledger();
  const out = await new Pipeline({ cwd: tmp, master: 'claude' }, led, call).run('간단한 질문');
  assert.equal(out.final, '단일 답');
  assert.equal(led.totals().calls, 2); // 계획 1 + 단계 1 (취합 없음)
});

await check('단계 실패는 파이프라인을 죽이지 않고 결과에 기록된다', async () => {
  const plan = JSON.stringify({
    steps: [
      { id: 'a', to: 'gemini', prompt: 'x', dependsOn: [] },
      { id: 'b', to: 'codex', prompt: 'y', dependsOn: [] },
    ],
  });
  const call = async (id, prompt) => {
    if (prompt.startsWith('You are the master orchestrator of a multi-agent')) {
      return { text: plan, usage: {} };
    }
    if (prompt.startsWith('You are the master orchestrator. Below are')) {
      return { text: '부분 취합', usage: {} };
    }
    if (id === 'codex') throw new Error('codex 다운');
    return { text: 'ok', usage: {} };
  };
  const p = new Pipeline({ cwd: tmp, master: 'claude' }, new Ledger(), call);
  const errs = [];
  p.on('step:error', (d) => errs.push(d));
  const out = await p.run('작업');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].id, 'b');
  assert.match(out.results.b.text, /실패: codex 다운/);
  assert.equal(out.final, '부분 취합');
});

// ── 스킬 채택 게이트 회귀 (master 지시 — 설치기 실결함 2건 고정) ──────────────

await check('회귀: 허용목록의 모든 등급 키가 반영된다(승인분 조용한 누락 방지)', () => {
  // 실결함: loadAllowlist 가 T1·T2 만 하드코딩해 읽어 master 가 새로 승인한 20개를 무시했다.
  const f = path.join(tmp, 'allow.json');
  fs.writeFileSync(
    f,
    JSON.stringify({
      source: { repo: 'x/y', commit: 'z', npx_pin: '0.0.0' },
      approved: { T1: ['aa'], T2: ['bb'], 'T3_나중에_추가된_등급': ['cc'] },
    })
  );
  const { names } = loadAllowlist(f);
  assert.deepEqual(names.sort(), ['aa', 'bb', 'cc'], '새 등급 키가 누락됨');
});

await check('회귀: 허용목록 이탈분은 디스크에서 제거된다(승인 철회가 가능해야 한다)', () => {
  // 실결함: 허용목록에서 빼도 디렉터리가 남아 승인 철회가 불가능했다.
  const dir = fs.mkdtempSync(path.join(tmp, 'skills-'));
  for (const n of ['keep-me', 'revoked']) {
    fs.mkdirSync(path.join(dir, n));
    fs.writeFileSync(path.join(dir, n, 'SKILL.md'), `---\nname: ${n}\n---\n`);
  }
  fs.writeFileSync(path.join(dir, 'PROVENANCE.json'), '{}'); // 파일은 건드리지 않는다
  const pruned = pruneExtraneous(dir, ['keep-me']);
  assert.deepEqual(pruned, ['revoked']);
  assert.ok(fs.existsSync(path.join(dir, 'keep-me')), '승인분이 지워졌습니다');
  assert.ok(!fs.existsSync(path.join(dir, 'revoked')), '철회분이 남았습니다');
  assert.ok(fs.existsSync(path.join(dir, 'PROVENANCE.json')), '파일까지 지웠습니다');
});

await check('npx 부동 semver 고정은 멱등이다(이중 치환 없음)', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'pin-'));
  const f = path.join(dir, 'SKILL.md');
  fs.writeFileSync(f, `run npx -y @nomadamas/k-skill@0 instruct x\nand @nomadamas/k-skill@0 exec y\n`);
  const a = pinNpxVersion(dir, '0.2.2');
  assert.equal(a.hits, 2);
  const once = fs.readFileSync(f, 'utf8');
  const b = pinNpxVersion(dir, '0.2.2'); // 두 번째 실행
  assert.equal(b.hits, 0, '이미 고정된 문자열을 다시 치환했습니다');
  assert.equal(fs.readFileSync(f, 'utf8'), once, '재실행이 내용을 바꿨습니다');
  assert.ok(!once.includes('@0.2.2.2'), '이중 치환이 발생했습니다');
});

await check('스킬 이름 화이트리스트가 경로 조작을 거부한다', () => {
  for (const bad of ['../etc', 'a/b', 'C:/x', '.hidden', 'UPPER', '']) {
    assert.ok(!SAFE_NAME.test(bad), `허용되면 안 되는 이름: ${bad}`);
  }
  for (const ok of ['korean-humanizer', 'k-dart', 'hwp']) {
    assert.ok(SAFE_NAME.test(ok), `허용돼야 하는 이름: ${ok}`);
  }
});

// ── E1 배선: CLI 백엔드 스킬 주입 (master 승인 · E4 조건 ②) ─────────────────

await check('E1: 스킬 디렉터리가 있으면 claude argv 에 --plugin-dir 이 붙는다', () => {
  const a = PROVIDERS.claude.buildArgs({ pluginDir: 'C:/x/skills' });
  const i = a.indexOf('--plugin-dir');
  assert.ok(i > 0, '--plugin-dir 이 없습니다');
  assert.equal(a[i + 1], 'C:/x/skills');
});

await check('E1 회귀: 스킬 디렉터리가 없으면 argv 가 종전과 바이트 동일하다', () => {
  // master E4 조건 ② — 스킬 미설치 사용자에게 무영향이어야 한다.
  assert.deepEqual(PROVIDERS.claude.buildArgs({}), ['-p', '--output-format', 'json']);
  assert.deepEqual(PROVIDERS.claude.buildArgs({ pluginDir: null }), ['-p', '--output-format', 'json']);
  assert.deepEqual(PROVIDERS.claude.buildArgs({ model: 'claude-opus-5' }), [
    '-p', '--output-format', 'json', '--model', 'claude-opus-5',
  ]);
});

await check('E1: 미승인 백엔드(gemini·codex) argv 는 변경되지 않는다', () => {
  // master E2(gemini 보류)·E3(codex 미지원) 판정 — 이 둘은 건드리지 않는다.
  assert.deepEqual(PROVIDERS.gemini.buildArgs({ pluginDir: '/x' }), ['-p', '', '-o', 'json', '--yolo']);
  assert.deepEqual(PROVIDERS.codex.buildArgs({ pluginDir: '/x' }), ['exec', '-', '--json']);
});

await check('E1: 매니페스트가 없으면 skillsPluginDir 은 null 이다', () => {
  const empty = fs.mkdtempSync(path.join(tmp, 'noskills-'));
  assert.equal(skillsPluginDir(empty), null);
});

await check('게이트 관철: plugin.json 은 승인분만·이름 오름차순으로 고정된다', () => {
  // 목록 순서가 흔들리면 프리픽스가 바뀌어 캐시가 무효화된다(성공기준 3 개정본).
  const dir = fs.mkdtempSync(path.join(tmp, 'manifest-'));
  const m = writePluginManifest(dir, ['zebra', 'alpha', 'mid']);
  assert.deepEqual(m.skills, ['./alpha', './mid', './zebra'], '정렬이 고정되지 않았습니다');
  const again = writePluginManifest(dir, ['mid', 'zebra', 'alpha']); // 입력 순서만 다름
  assert.deepEqual(again.skills, m.skills, '입력 순서에 따라 목록이 흔들립니다');
  assert.ok(fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json')));
});

// ── (b)안 배선: api 백엔드 스킬 지연 도구 ──────────────────────────────────

/** frontmatter 만 있는 최소 SKILL.md. */
const skillMd = (name, desc) => `---\nname: ${name}\ndescription: ${desc}\nlicense: MIT\n---\n\n# ${name}\n`;

/** 임시 스킬 루트. 매니페스트까지 써야 노출된다(설치 목록 = 노출 목록). */
function fakeSkillRoot(files, { manifest = Object.keys(files) } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'sk-'));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'SKILL.md'), body);
  }
  if (manifest) writePluginManifest(dir, manifest);
  return dir;
}

await check('(b)안: 스킬 1개당 지연 도구 1개가 이름 오름차순으로 생긴다', () => {
  const dir = fakeSkillRoot({
    'b-two': skillMd('b-two', '두 번째 스킬'),
    'a-one': skillMd('a-one', '첫 번째 스킬'),
  });
  const tools = skillTools(dir);
  assert.equal(tools.length, 2);
  // 정렬이 흔들리면 도구 배열이 바뀌고 tools·system·messages 캐시가 통째로 날아간다(성공기준 3).
  assert.deepEqual(tools.map((t) => t.name), ['skill_a_one', 'skill_b_two']);
  assert.equal(tools[0].description, '첫 번째 스킬', 'description 은 벤더 원문 그대로여야 합니다');
  assert.deepEqual(tools[0].input_schema, { type: 'object', properties: {} });
});

await check('(b)안: 스킬 도구는 전부 지연이고 비지연 도구·tool_search 계약이 유지된다', () => {
  const dir = fakeSkillRoot({ solo: skillMd('solo', '설명') });
  const tools = buildTools({ ...cfg, deferTools: true }, { skillRoot: dir });
  const skills = tools.filter((t) => t.name?.startsWith('skill_'));
  assert.equal(skills.length, 1);
  assert.ok(skills.every((t) => t.defer_loading === true), '스킬 도구가 비지연으로 실렸습니다');
  // 전량 지연이면 400(At least one tool must have defer_loading=false).
  assert.ok(tools.some((t) => t.input_schema && !t.defer_loading), '비지연 도구가 하나도 없습니다');
  const search = tools.find((t) => typeof t.type === 'string' && t.type.startsWith('tool_search'));
  assert.ok(search, 'tool_search 가 없습니다');
  assert.ok(!('defer_loading' in search), 'tool_search 에 defer_loading 이 붙으면 400 입니다');
});

await check('(b)안: deferTools=false 분기에는 스킬이 실리지 않는다(프리픽스 폭발 방지)', () => {
  const dir = fakeSkillRoot({ solo: skillMd('solo', '설명') });
  const tools = buildTools({ ...cfg, deferTools: false }, { skillRoot: dir });
  assert.ok(!tools.some((t) => t.name?.startsWith('skill_')), '즉시 로드 분기에 스킬이 섞였습니다');
  assert.deepEqual(tools.map((t) => t.name).slice(0, CORE_TOOLS.length), CORE_TOOLS.map((t) => t.name));
});

await check('(b)안: 시스템 프롬프트는 스킬 설치 여부와 무관하게 바이트 동일하다(성공기준 3)', () => {
  // 프리픽스에 스킬 정보가 새어 들어가는 순간 캐시가 매 설치마다 무효화된다.
  const before = JSON.stringify(buildSystem(cfg));
  buildTools({ ...cfg, deferTools: true }, { skillRoot: fakeSkillRoot({ solo: skillMd('solo', 'x') }) });
  assert.equal(JSON.stringify(buildSystem(cfg)), before);
  assert.ok(!before.includes('skill_'), 'system 블록에 스킬 이름이 들어 있습니다');
});

await check('(b)안: 노출 목록은 plugin.json 이 정한다(디스크에 있어도 매니페스트에 없으면 미노출)', () => {
  const dir = fakeSkillRoot(
    { listed: skillMd('listed', '노출됨'), stray: skillMd('stray', '매니페스트에 없음') },
    { manifest: ['listed'] }
  );
  assert.deepEqual(loadSkills(dir).skills.map((s) => s.name), ['listed']);
  assert.ok(fs.existsSync(path.join(dir, 'stray')), '테스트 전제(디스크에는 존재)가 깨졌습니다');
});

await check('(b)안: 매니페스트가 없으면 api 경로 노출도 0 이다(CLI 경로와 같은 게이트)', () => {
  const dir = fakeSkillRoot({ solo: skillMd('solo', '설명') }, { manifest: null });
  assert.equal(manifestNames(dir), null);
  assert.deepEqual(skillTools(dir), []);
  assert.equal(skillsPluginDir(path.dirname(dir)), null); // CLI 경로도 동시에 닫힌다
});

await check('frontmatter 파서: 실측 4형태(평문·홑따옴표·겹따옴표·블록 |)를 같게 읽는다', () => {
  const plain = parseFrontmatter('---\nname: a\ndescription: 값 하나\n---\n');
  const single = parseFrontmatter("---\nname: a\ndescription: '값 하나'\n---\n");
  const dbl = parseFrontmatter('---\nname: a\ndescription: "값 하나"\n---\n');
  for (const p of [plain, single, dbl]) assert.equal(p.description, '값 하나');
  const block = parseFrontmatter('---\nname: a\ndescription: |\n  첫 줄\n  둘째 줄\nlicense: MIT\n---\n');
  assert.equal(block.description, '첫 줄\n둘째 줄');
  assert.equal(parseFrontmatter("---\nname: a\ndescription: 'it''s'\n---\n").description, "it's");
});

await check('frontmatter 파서 negative-case: 결함은 조용히 넘어가지 않고 사유와 함께 실패한다', () => {
  assert.throws(() => parseFrontmatter('# 제목만 있는 파일\n'), /frontmatter/);
  assert.throws(() => parseFrontmatter('---\ndescription: 설명만\n---\n'), /name/);
  assert.throws(() => parseFrontmatter('---\nname: a\n---\n'), /description/);
  // 결함 스킬은 목록에서 빠지되 사유가 남는다.
  const dir = fakeSkillRoot({ broken: '설명 없는 본문\n', fine: skillMd('fine', '정상') });
  const { skills, skipped } = loadSkills(dir);
  assert.deepEqual(skills.map((s) => s.name), ['fine']);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /frontmatter/);
});

await check('frontmatter 파서: 디렉터리명과 name 이 다르면 노출하지 않는다', () => {
  const dir = fakeSkillRoot({ 'dir-name': skillMd('other-name', '설명') });
  const { skills, skipped } = loadSkills(dir);
  assert.equal(skills.length, 0);
  assert.match(skipped[0].reason, /불일치/);
});

await check('skill_* 핸들러는 안전 문구를 본문 **앞**에 붙여 로컬 사본을 돌려준다', async () => {
  const dir = fakeSkillRoot({ solo: skillMd('solo', '설명') });
  fs.writeFileSync(path.join(dir, 'solo', 'instruction.md'), '로컬 전체 지침 본문');
  const out = skillBody('skill_solo', dir);
  assert.ok(out.startsWith(SAFETY), '안전 문구가 앞에 없습니다(잘리면 규약이 사라집니다)');
  assert.ok(out.includes('로컬 전체 지침 본문'), 'instruction.md 본문이 없습니다');
  assert.ok(out.includes('로컬 사본이다'), '로컬 경로 고지가 없습니다');
  assert.ok(!out.includes('npx -y @nomadamas'), '네트워크 경로를 지시하고 있습니다');
});

await check('skill_* 핸들러: 없는 스킬·경로 조작은 본문을 열지 않고 실패한다', () => {
  const dir = fakeSkillRoot({ solo: skillMd('solo', '설명') });
  assert.throws(() => skillBody('skill_nope', dir), /설치되지 않은 스킬/);
  assert.throws(() => skillBody('skill_../../etc/passwd', dir), /허용되지 않는 스킬 이름/);
});

await check('skill_* 는 execTool 로 라우팅되고 결과 상한에 잘리지 않는다', async () => {
  const dir = fakeSkillRoot({ solo: skillMd('solo', '설명') });
  fs.writeFileSync(path.join(dir, 'solo', 'instruction.md'), 'ㄱ'.repeat(9000));
  // execTool 은 기본 SKILLS_ROOT 를 보므로, 임시 루트 검증은 skillBody 로 하고
  // 라우팅 자체(알 수 없는 도구로 떨어지지 않는지)와 상한 예외만 여기서 본다.
  const long = skillBody('skill_solo', dir);
  assert.ok(long.length > cfg.toolResultCap, '테스트 전제(상한 초과)가 깨졌습니다');
  await assert.rejects(() => execTool('skill_없는이름', {}, cfg, {}), /허용되지 않는 스킬 이름/);
  await assert.rejects(() => execTool('nosuchtool', {}, cfg, {}), /알 수 없는 도구/);
});

await check('실측: 설치본 노출 목록 = plugin.json 목록 · 보류분 미노출', () => {
  // 스킬 미설치 저장소에서도 도는 테스트다 — 그때는 "노출 0" 이 정답이다.
  const names = manifestNames(SKILLS_ROOT);
  const tools = skillTools(SKILLS_ROOT);
  if (!names) {
    assert.equal(tools.length, 0, '매니페스트가 없는데 스킬이 노출됐습니다');
    return;
  }
  assert.equal(tools.length, names.length, '매니페스트 수와 도구 수가 다릅니다');
  assert.deepEqual(tools.map((t) => t.name), names.map((n) => `skill_${n.replace(/-/g, '_')}`).sort());
  // 오너 경계로 설치 보류된 항목이 api 경로로 새지 않는지(게이트 관철).
  for (const held of ['k-skill-setup', 'gov-overseas-trip-report', 'corporate-registration-consulting']) {
    assert.ok(!names.includes(held), `보류분이 노출됐습니다: ${held}`);
  }
  assert.ok(tools.every((t) => /^[a-zA-Z0-9_-]{1,128}$/.test(t.name)), '도구 이름 규격 위반');
});

await check('벤더 CLI 우회: instruct·files 는 프로세스 없이 로컬 본문으로 답한다', () => {
  const dir = fakeSkillRoot({ solo: skillMd('solo', '설명') });
  fs.writeFileSync(path.join(dir, 'solo', 'instruction.md'), '로컬 전체 지침');
  fs.mkdirSync(path.join(dir, 'solo', 'scripts'));
  fs.writeFileSync(path.join(dir, 'solo', 'scripts', 'run.py'), 'print(1)\n');

  const ins = rewriteVendorCommand('npx -y @nomadamas/k-skill@0.2.2 instruct solo', dir);
  assert.equal(ins.kind, 'text');
  assert.ok(ins.text.startsWith(SAFETY) && ins.text.includes('로컬 전체 지침'));

  const files = rewriteVendorCommand('npx -y @nomadamas/k-skill@0.2.2 files solo', dir);
  assert.equal(files.kind, 'text');
  assert.ok(files.text.includes('scripts/run.py'));
});

await check('벤더 CLI 우회: exec 는 로컬 사본 실행으로 재작성되고 그 사실을 밝힌다', () => {
  const dir = fakeSkillRoot({ solo: skillMd('solo', '설명') });
  fs.mkdirSync(path.join(dir, 'solo', 'scripts'));
  fs.writeFileSync(path.join(dir, 'solo', 'scripts', 'run.py'), 'print(1)\n');
  const r = rewriteVendorCommand(
    'npx -y @nomadamas/k-skill@0.2.2 exec solo scripts/run.py -- --flag v',
    dir
  );
  assert.equal(r.kind, 'argv');
  assert.equal(r.bin, 'python3');
  // 문자열이 아니라 argv 로 돌려준다 — 셸 재해석 여지를 없앤다.
  assert.deepEqual(r.argv, [path.join(dir, 'solo', 'scripts', 'run.py'), '--flag', 'v']);
  assert.ok(r.note.includes('로컬 사본'), '바꿔치기를 알리지 않습니다');
});

await check('벤더 CLI 우회 negative: 경로 탈출·미설치·미지원 확장자·무관 명령은 손대지 않는다', () => {
  const dir = fakeSkillRoot({ solo: skillMd('solo', '설명') });
  fs.mkdirSync(path.join(dir, 'solo', 'scripts'));
  fs.writeFileSync(path.join(dir, 'solo', 'scripts', 'run.py'), 'print(1)\n');
  fs.writeFileSync(path.join(dir, 'solo', 'scripts', 'data.bin'), 'x');
  const none = [
    'npx -y @nomadamas/k-skill@0.2.2 exec solo ../../../etc/passwd', // 경로 탈출
    'npx -y @nomadamas/k-skill@0.2.2 exec nosuch scripts/run.py', // 미설치 스킬
    'npx -y @nomadamas/k-skill@0.2.2 exec solo scripts/data.bin', // 실행기 모름
    'npx -y @nomadamas/k-skill@0.2.2 exec solo missing.py', // 없는 파일
    'ls -la', // 무관 명령
  ];
  for (const c of none) assert.equal(rewriteVendorCommand(c, dir), null, `가로채면 안 됨: ${c}`);
});

// ── 설치 시 스킬 정합 검증(오너 지시: clone + install 만으로 자동 적용 · 실패 금지) ────────

/** 정합이 맞는 스킬 루트 한 벌(매니페스트 + PROVENANCE + 허용목록)을 만든다. */
function verifiableSkillRoot(names, { manifest = names, provenance = names, extraFile } = {}) {
  const dir = fakeSkillRoot(Object.fromEntries(names.map((n) => [n, skillMd(n, `${n} 설명`)])), {
    manifest,
  });
  fs.writeFileSync(
    path.join(dir, 'PROVENANCE.json'),
    JSON.stringify({ repo: 'x/y', commit: 'c'.repeat(40), names: provenance })
  );
  const allow = path.join(dir, 'allow.json');
  fs.writeFileSync(
    allow,
    JSON.stringify({ source: { repo: 'x/y', commit: 'c', npx_pin: '0.2.2' }, approved: { T1: names } })
  );
  if (extraFile) fs.writeFileSync(path.join(dir, names[0], extraFile.name), extraFile.body);
  return { dir, allowlistFile: allow };
}

await check('설치 검증: 스킬이 없으면 none 이고 설치를 실패시키지 않는다', () => {
  // 오너 조건 — 스킬 부재는 결함이 아니다. 에이전트는 스킬 없이 동작한다.
  const empty = fs.mkdtempSync(path.join(tmp, 'noskill-'));
  assert.equal(verifySkills(empty).status, 'none');
});

await check('설치 검증: 정합이면 ok — 매니페스트·디스크·PROVENANCE·허용목록 4자 일치', () => {
  const { dir, allowlistFile } = verifiableSkillRoot(['alpha', 'beta']);
  const r = verifySkills(dir, { allowlistFile });
  assert.equal(r.status, 'ok', r.checks.filter((c) => !c.ok).map((c) => c.name).join(', '));
  assert.equal(r.count, 2);
});

await check('설치 검증: 매니페스트에 없는 디렉터리가 남아 있으면 잡아낸다', () => {
  // 승인 철회 후 디렉터리만 남는 상황 = 회수되지 않은 게이트.
  const { dir, allowlistFile } = verifiableSkillRoot(['alpha', 'beta'], {
    manifest: ['alpha'],
    provenance: ['alpha'],
  });
  const r = verifySkills(dir, { allowlistFile });
  assert.equal(r.status, 'fail');
  const hit = r.checks.find((c) => c.name.includes('디스크 디렉터리'));
  assert.ok(!hit.ok);
  assert.ok(hit.extra().some((l) => l.includes('beta')), 'beta 를 지목하지 못했습니다');
});

await check('설치 검증: 부동 semver(@0) 잔존을 잡아낸다', () => {
  const { dir, allowlistFile } = verifiableSkillRoot(['alpha'], {
    extraFile: { name: 'instruction.md', body: 'npx -y @nomadamas/k-skill@0 instruct alpha\n' },
  });
  const r = verifySkills(dir, { allowlistFile });
  assert.equal(r.status, 'fail');
  assert.ok(!r.checks.find((c) => c.name.includes('부동 semver')).ok);
  // 고정판은 잔존으로 세지 않는다(멱등 경계).
  fs.writeFileSync(
    path.join(dir, 'alpha', 'instruction.md'),
    'npx -y @nomadamas/k-skill@0.2.2 instruct alpha\n'
  );
  assert.equal(scanFloating(dir).length, 0);
});

await check('설치 스크립트는 스킬을 네트워크에서 다시 받지 않는다(확인만 한다)', () => {
  // 오너 경계 — skills/ 는 git 추적분이다. 설치기가 받는 순간 고정 커밋 보장이 깨진다.
  const root = path.resolve(fileURLToPath(import.meta.url), '..', '..');
  for (const f of ['install.sh', 'install.ps1']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(src.includes('skills-verify.js'), `${f} 에 스킬 확인 단계가 없습니다`);
    assert.ok(!/skills-install\.js|skills:install|codeload/.test(src), `${f} 가 스킬을 내려받습니다`);
  }
});

await check('설치 스크립트는 스킬 확인을 마지막 단계로 둔다(고지가 마지막에 읽히도록)', () => {
  // 개수 고지와 잔여 위험 문장이 셈 생성·PATH 안내에 밀려 스크롤 위로 사라지면 고지가 아니다.
  const root = path.resolve(fileURLToPath(import.meta.url), '..', '..');
  for (const [f, tail] of [
    ['install.sh', 'BIN_DIR'],
    ['install.ps1', 'shimDir'],
  ]) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(
      src.lastIndexOf('skills-verify.js') > src.lastIndexOf(tail),
      `${f}: 스킬 확인이 셈 생성/PATH 단계보다 앞에 있습니다`
    );
  }
});

await check('설치 스크립트는 스킬 확인 실패로 설치를 중단하지 않는다', () => {
  // 오너 조건 ③ — 정합이 어긋나도 경고까지다.
  const root = path.resolve(fileURLToPath(import.meta.url), '..', '..');
  // 주석은 걷어내고 **실행되는 줄만** 본다 — 규칙을 설명한 주석이 그 규칙 위반으로 잡히면 안 된다.
  const code = (s) =>
    s
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');

  const sh = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
  const shStep = code(sh.slice(sh.lastIndexOf('skills-verify.js')));
  assert.ok(/^\s*warn /m.test(shStep), 'install.sh: 스킬 확인 실패가 경고로 처리되지 않습니다');
  assert.ok(!/\bexit\b/.test(shStep), 'install.sh: 스킬 확인 실패가 설치를 중단시킵니다');

  const ps = fs.readFileSync(path.join(root, 'install.ps1'), 'utf8');
  const psStep = code(ps.slice(ps.lastIndexOf('skills-verify.js')));
  assert.ok(/^\s*Warn /m.test(psStep), 'install.ps1: 스킬 확인 실패가 경고로 처리되지 않습니다');
  assert.ok(!/\bexit 1\b|\bthrow\b/.test(psStep), 'install.ps1: 스킬 확인 실패가 설치를 중단시킵니다');
});

await check('install.ps1 은 스킬 확인을 마지막에 두고도 종료 코드 0 을 돌려준다', () => {
  // setup.ps1 이 이 스크립트의 종료 코드로 "설치 실패"를 판정하므로, 스킬 경고가
  // 설치 전체를 뒤집지 않도록 마지막을 exit 0 으로 못박는다(오너 조건 ③).
  // 실측 주의: 현재 형태(try/finally 로 끝남)에서는 명시적 exit 없이도 0 이 나왔다 —
  // 이 검사는 살아 있는 버그를 막는 것이 아니라, 편집 한 번으로 그 성질이
  // 조용히 뒤집히는 것을 막는 회귀 고정이다.
  const root = path.resolve(fileURLToPath(import.meta.url), '..', '..');
  const ps = fs.readFileSync(path.join(root, 'install.ps1'), 'utf8');
  const psStep = ps.slice(ps.lastIndexOf('skills-verify.js'));
  assert.ok(/\bexit 0\b/.test(psStep), 'install.ps1: 스킬 확인 뒤에 명시적 exit 0 이 없습니다');
  assert.ok(
    ps.trimEnd().endsWith('exit 0'),
    'install.ps1: exit 0 뒤에 다른 명령이 붙어 종료 코드가 다시 흔들립니다'
  );

  // 이 계약을 소비하는 쪽이 실제로 종료 코드를 본다는 사실도 함께 고정한다.
  const setup = fs.readFileSync(path.join(root, 'setup.ps1'), 'utf8');
  assert.ok(
    /LASTEXITCODE -ne 0.*throw/s.test(setup),
    'setup.ps1 의 종료 코드 판정이 사라졌다면 위 계약의 근거를 다시 확인하라'
  );
});

await check('스킬 확인은 개수와 잔여 위험을 함께 고지한다 — "안전하다"고 쓰지 않는다', () => {
  // 지시 3항. 소스 문자열이 아니라 **실제로 찍히는 출력**을 본다
  // (주석에 규칙을 설명해 둔 것까지 위반으로 잡히면 안 되고, 반대로 고지가 죽어도 알아채야 한다).
  const root = path.resolve(fileURLToPath(import.meta.url), '..', '..');
  const r = spawnSync(process.execPath, [path.join('src', 'tools', 'skills-verify.js')], {
    cwd: root,
    encoding: 'utf8',
  });
  const out = `${r.stdout}${r.stderr}`;
  const expected = verifySkills();

  if (expected.status === 'none') {
    // 스킬 없는 체크아웃 — 고지할 스킬이 없으니 위험 문구도 없는 것이 맞다.
    assert.equal(r.status, 0, '스킬 부재인데 확인 단계가 0 이 아닌 코드로 끝났습니다');
    assert.match(out, /스킬 없음/);
    return;
  }
  assert.match(out, new RegExp(`스킬 ${expected.count}개`), '개수 고지가 없습니다');
  assert.match(out, /제3자 파이썬 코드/, '잔여 위험 고지가 없습니다');
  assert.match(out, /없애지는 않았다/, '제거하지 않았다는 사실이 빠졌습니다');
  assert.ok(!/안전합니다|안전하다/.test(out), '안전 보증 문구가 출력됐습니다');
});

await check('배포 목록(package.json files)에 skills 가 들어 있다', () => {
  // clone 경로와 npm 패키징 경로가 갈리면 한쪽에서만 스킬이 조용히 사라진다.
  const root = path.resolve(fileURLToPath(import.meta.url), '..', '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('skills'), 'files 배열에 skills 가 없습니다');
  assert.equal(pkg.scripts['skills:verify'], 'node ./src/tools/skills-verify.js');
});

// ── 출고 본문 정책 치환 (독립검증 지적 A′·B′·B″ · 2026-08-03) ──────────────────
// 대조 범위가 상류 **머리말**뿐이었던 것이 범위 결함이었다. 모델이 실제로 받는 것은
// SAFETY + **본문**이고, 머리말에서 없앤 결함이 본문에 그대로 남아 있었다.

const policyRoot = (body) => {
  const dir = fs.mkdtempSync(path.join(tmp, 'policy-'));
  fs.mkdirSync(path.join(dir, 'ktx-booking'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ktx-booking', 'instruction.md'), body);
  return dir;
};

await check('A′: 부재 도구 `clarify` 지시를 실재 승인 게이트 문구로 치환한다', () => {
  // jini 실도구 10종에 clarify 는 없다. 부를 수 없는 도구로 승인받으라는 지시는
  // 「안전 조항은 있고 기전은 없는 상태」 — 조항이 없는 것보다 나쁘다(거짓 보증).
  const dir = policyRoot(
    '3. 실제 결제 버튼 직전에 `clarify`로 총액을 보여주고 승인받는다.\n' +
      '- 돌쇠의 예매 완료 요청이면 `clarify` 승인 후 영수증을 확인했다\n'
  );
  const r = applyBodyPolicy(dir);
  const out = fs.readFileSync(path.join(dir, 'ktx-booking', 'instruction.md'), 'utf8');
  assert.ok(!/`clarify`/.test(out), 'clarify 도구 지시가 남았습니다');
  assert.match(out, /승인 게이트\(`write`·`edit`·`bash`·`git`\)/, '실재 기전 이름이 들어가지 않았습니다');
  assert.equal(r.residual.clarify.length, 0);
});

await check('B″: 「결제 완료」를 완료 조건으로 삼은 Done when 문장을 우리 경계로 치환한다', () => {
  // A′ 만으로는 부족하다 — 도구 이름을 실재 기전으로 바꿔도 「결제를 완료해야 끝」이라는
  // 목표가 남으면 모델은 여전히 결제로 향한다. 기전이 아니라 목표를 고쳐야 하는 항목이다.
  const dir = policyRoot('- 돌쇠의 예매 완료 요청이면 `clarify` 승인 후 결제 완료 상태를 확인했다\n');
  const r = applyBodyPolicy(dir);
  const out = fs.readFileSync(path.join(dir, 'ktx-booking', 'instruction.md'), 'utf8');
  assert.match(out, /대신 완료하지 않고/, '경계 문구로 치환되지 않았습니다');
  assert.ok(!/결제 완료 상태를 확인했다/.test(out), '결제 완료가 완료 조건으로 남았습니다');
  assert.equal(r.residual.payment.length, 0);
});

await check('B′: Notes 절의 결제 예외 문장을 치환한다 (삭제가 아니라 대체)', () => {
  const dir = policyRoot(
    '- 결제 자동화 금지는 generic fallback에만 적용한다. 돌쇠에서는 `clarify` 승인 후 공식 결제 표면으로 완료한다\n'
  );
  applyBodyPolicy(dir);
  const out = fs.readFileSync(path.join(dir, 'ktx-booking', 'instruction.md'), 'utf8');
  assert.ok(!/generic fallback에만 적용한다/.test(out), '경계 충돌 문장이 남았습니다');
  assert.match(out, /사용자가 공식 표면에서 직접 마친다/);
  assert.match(out, /jini 경계/, '무엇을 왜 바꿨는지 본문에 남지 않았습니다');
});

await check('치환 순서 강제: B 계열이 A′ 보다 먼저 — 아니면 경계 위반이 살아남는다', () => {
  // A′ 를 먼저 돌리면 B 문장이 「승인 게이트 통과 후 … 완료한다」로 바뀌어
  // 문장은 그럴듯해지고 **경계 위반은 그대로 남는다.** 가장 위험한 실패 모드다.
  const dir = policyRoot(
    '- 결제 자동화 금지는 generic fallback에만 적용한다. 돌쇠에서는 `clarify` 승인 후 공식 결제 표면으로 완료한다\n'
  );
  applyBodyPolicy(dir);
  const out = fs.readFileSync(path.join(dir, 'ktx-booking', 'instruction.md'), 'utf8');
  assert.ok(!/공식 결제 표면으로 완료한다/.test(out), 'A′ 가 먼저 돌아 경계 위반이 살아남았습니다');
});

await check('치환은 멱등이다 — 재설치·재실행에 누적되지 않는다', () => {
  const dir = policyRoot(
    '3. `clarify`로 총액을 승인받는다.\n' +
      '- 결제 자동화 금지는 generic fallback에만 적용한다. 돌쇠에서는 `clarify` 승인 후 공식 결제 표면으로 완료한다\n'
  );
  applyBodyPolicy(dir);
  const once = fs.readFileSync(path.join(dir, 'ktx-booking', 'instruction.md'), 'utf8');
  const again = applyBodyPolicy(dir);
  assert.equal(again.clarify.hits, 0, '2회차에 또 치환했습니다');
  assert.equal(again.payment.hits, 0, '2회차에 또 치환했습니다');
  assert.equal(fs.readFileSync(path.join(dir, 'ktx-booking', 'instruction.md'), 'utf8'), once);
});

await check('산문 속 영어 clarify 는 결함이 아니다 — 상류 본문을 뜻 없이 훼손하지 않는다', () => {
  // 「### 1. Clarify the need」는 「필요를 명확히 하라」는 제목이지 도구 호출이 아니다.
  // 이 구분이 없으면 잔존 0 을 영원히 만족시킬 수 없고, 지우면 원문을 훼손한다.
  const dir = policyRoot('### 1. Clarify the need\n\n검색어가 너무 넓으면 좁힌다.\n');
  const r = applyBodyPolicy(dir);
  assert.equal(r.residual.clarify.length, 0, '산문을 결함으로 셌습니다');
  assert.equal(r.residual.prose.length, 1, '산문 언급을 기록하지 않았습니다(은닉 금지)');
  assert.match(
    fs.readFileSync(path.join(dir, 'ktx-booking', 'instruction.md'), 'utf8'),
    /Clarify the need/,
    '산문을 훼손했습니다'
  );
});

await check('B‴: 「승인되면 결제를 실행하고」 류 실행 지시를 제거한다', () => {
  // ★가장 잘 숨었던 형태 — 승인을 요청하는 줄 **바로 다음 번호 줄**이 실행 지시였다.
  // A′ 로 승인 줄만 고치면 문장이 그럴듯해지고 실행 지시는 살아남는다(B″ 교훈의 재발).
  const dir = policyRoot(
    '3. 실제 결제 버튼 직전에 `clarify`로 총액을 보여주고 승인받는다.\n' +
      '4. 승인되면 결제를 실행하고 결제 완료 화면, 예약번호, 영수증/결제 상태를 확인한다.\n'
  );
  const r = applyBodyPolicy(dir);
  const out = fs.readFileSync(path.join(dir, 'ktx-booking', 'instruction.md'), 'utf8');
  assert.ok(!/승인되면 결제를 실행/.test(out), '결제 실행 지시가 남았습니다');
  assert.match(out, /결제는 실행하지 않는다/);
  assert.equal(r.residual.payment.length, 0);
});

await check('B‴: 계정 상태 생성(장바구니) 지시를 제거한다 — 가역성은 근거가 아니다', () => {
  // master 판정: 경계 기준은 「비가역이냐」가 아니라 「오너의 실제 계정에 상태를 만드느냐」다.
  // 상류는 「가역적이므로 별도 승인 없이 수행」이라고 적었는데 그 근거가 기각된 것이다.
  const dir = policyRoot(
    '4. 옵션과 수량을 선택해 장바구니에 담는다. 장바구니 담기는 가역적이므로 별도 승인 없이 수행하고 실제 담김 상태를 확인한다.\n'
  );
  applyBodyPolicy(dir);
  const out = fs.readFileSync(path.join(dir, 'ktx-booking', 'instruction.md'), 'utf8');
  assert.ok(!/별도 승인 없이 수행/.test(out), '승인 없이 수행하라는 지시가 남았습니다');
  assert.match(out, /장바구니에 담지 않는다/);
  assert.match(out, /오너 계정에 상태를 만드는 실행/, '기각된 근거를 대체한 논거가 없습니다');
});

await check('판단 대기 예외는 결함 0 과 구분해 센다 — 패턴을 지워 0 을 만들지 않는다', () => {
  // 스캐너 패턴을 지워 잔존 0 을 만드는 것은 검사를 속이는 것이다.
  // 예외는 이름으로 선언하고 **따로 세어** 보이게 둔다 — 잔존 0 과 예외 1 은 다른 말이다.
  assert.ok(PENDING_JUDGMENT.length >= 1, '선언된 예외 목록이 비었습니다');
  for (const p of PENDING_JUDGMENT) {
    assert.match(p.at, /^[\w-]+\/[\w.-]+:\d+$/, `예외 위치 형식이 아닙니다: ${p.at}`);
    assert.ok(p.why && p.why.length > 10, `예외에 사유가 없습니다: ${p.at}`);
  }
  const r = scanBodyPolicy(SKILLS_ROOT);
  assert.equal(r.pending.length, PENDING_JUDGMENT.length, '선언된 예외 수와 실측이 다릅니다');
});

await check('A″: 부재 자격증명 도구 지시를 치환하되 보호 문구는 보존한다', () => {
  // ★같은 줄 뒤쪽에 보호 문구가 붙어 있다. 줄째 치환하면 보호까지 지워 **퇴행**이다.
  // 그래서 문장 단위로 자른다(마침표를 넘지 않는다).
  const dir = policyRoot(
    '- 돌쇠 credential mode에서는 `vault-run` capability를 사용하고, 없으면 `request_vault_credential`을 호출한다. ID/PW 원문을 채팅이나 shell에 넣지 않는다.\n' +
      '3. 로그인이 필요하면 provisioned vault capability를 사용하고, 없으면 `request_vault_credential`로 쿠팡 login을 저장한 뒤 같은 turn에 재개한다.\n'
  );
  const r = applyBodyPolicy(dir);
  const out = fs.readFileSync(path.join(dir, 'ktx-booking', 'instruction.md'), 'utf8');
  assert.ok(!/request_vault_credential|`vault-run`/.test(out), '부재 도구 지시가 남았습니다');
  assert.match(out, /ID\/PW 원문을 채팅이나 shell에 넣지 않는다/, '보호 문구가 지워졌습니다(퇴행)');
  assert.match(out, /^- 자격증명은 사용자가 직접 입력한다/m, '불릿 머리가 보존되지 않았습니다');
  assert.match(out, /^3\. 로그인·키 입력은 사용자가 직접 수행한다/m, '번호 머리가 보존되지 않았습니다');
  assert.equal(r.residual.clarify.length, 0);
});

await check('선언된 예외는 설치 검증 출력에 드러난다 — 조용한 예외는 구멍이다', () => {
  // master 조건2. 사용자가 설치 화면에서 예외를 보게 한다.
  const root = path.resolve(fileURLToPath(import.meta.url), '..', '..');
  const r = spawnSync(process.execPath, [path.join('src', 'tools', 'skills-verify.js')], {
    cwd: root,
    encoding: 'utf8',
  });
  const out = `${r.stdout}${r.stderr}`;
  if (verifySkills().status === 'none') return; // 스킬 없는 체크아웃은 해당 없음
  assert.match(out, new RegExp(`정책 예외 ${PENDING_JUDGMENT.length}건`), '예외 개수가 출력되지 않았습니다');
  for (const p of PENDING_JUDGMENT) {
    assert.ok(out.includes(p.at), `예외 위치가 출력되지 않았습니다: ${p.at}`);
  }
  assert.ok(!/정책 예외 1건:/.test(out), '개수를 하드코딩한 출력이 남아 있습니다');
});

// ── PROVENANCE 원장 재생성 정합 (worker 최종 재검증 반증 · 2026-08-03) ──────────────
// 반증: 치환 코드와 modifications 나열이 **따로** 있어서 계열이 늘 때 원장 나열을 빼먹었다.
// 코드 3항목 대 파일 5항목으로 벌어졌고, skills:install 을 한 번 돌리면 B‴·A″ 기록이 사라진다.
// 「은닉은 안 된다」는 원칙이 재설치 시점에 깨지는 구조적 결함이다.

await check('원장 재생성: modifications 는 계열 표에서 생성된다 — 손 나열이 아니다', () => {
  const groups = {};
  for (const g of POLICY_GROUPS) groups[g.key] = { files: 1, hits: 2 };
  const mods = buildModifications({ pin: { files: 3, hits: 4 }, npxPin: '0.2.2', groups });

  assert.equal(mods.length, 1 + POLICY_GROUPS.length, '항목 수가 계열 수와 맞지 않습니다');
  assert.match(mods[0].what, /@nomadamas\/k-skill@0\.2\.2/, '첫 항목이 npx 핀이 아닙니다');
  assert.equal(mods[0].occurrences, 4);
  POLICY_GROUPS.forEach((g, i) => {
    const m = mods[i + 1];
    assert.equal(m.what, g.what, `${g.key} 기재문이 계열 표와 다릅니다`);
    assert.ok(m.why && m.why.length > 30, `${g.key} 에 why 가 없습니다(은닉 금지)`);
    assert.equal(m.files, 1);
    assert.equal(m.occurrences, 2);
  });
});

await check('원장 재생성: 건수 0 인 계열도 항목을 남긴다 — 사라지면 미검사와 구별 안 된다', () => {
  const groups = {};
  for (const g of POLICY_GROUPS) groups[g.key] = { files: 0, hits: 0 };
  const mods = buildModifications({ pin: { files: 0, hits: 0 }, npxPin: '0.2.2', groups });
  assert.equal(mods.length, 1 + POLICY_GROUPS.length, '0건 계열이 목록에서 사라졌습니다');
  assert.ok(mods.every((m) => m.occurrences === 0));
});

await check('★원장 재생성 = 커밋본 정합: 계열명·개수가 어긋나면 재설치가 기록을 지운다', () => {
  // 이 검사가 없어서 코드 3 대 파일 5 가 아무에게도 안 걸렸다(skills-verify 도 modifications 를
  // 참조하지 않았다 — 참조 0회 실측). 이제 계열명까지 대조한다.
  const committed = JSON.parse(
    fs.readFileSync(path.join(SKILLS_ROOT, 'PROVENANCE.json'), 'utf8')
  ).modifications;

  assert.equal(
    committed.length,
    1 + POLICY_GROUPS.length,
    `커밋본 ${committed.length}항목 대 코드 ${1 + POLICY_GROUPS.length}항목 — 재설치 시 기록이 사라진다`
  );

  // 커밋본 2항목에는 손으로 붙인 파일·줄 목록 접미가 남아 있다(`… (coupang 137·142 …)`).
  // 그 줄번호는 **치환 직후 이미 낡는다** — 내용이 바뀌면 줄이 밀린다. 그래서 계열 표의
  // `what` 은 변경 내용만 적고, 정량은 files/occurrences 가, 줄 단위 감사는
  // verification.md §9~§12 표가 진다. 대조는 그 휘발성 접미를 벗기고 **계열**을 본다.
  // 백틱은 마크다운 서식이지 내용이 아니다 — 커밋본은 백틱 없이, 계열 표는 백틱을 달고 적혀 있다.
  // 서식 차이로 정합 검사가 깨지면 검사가 내용을 못 보고 표기를 보게 된다.
  const stripVolatile = (s) => s.replace(/\s*\([^()]*\d[^()]*\)\s*$/, '').replace(/`/g, '');
  POLICY_GROUPS.forEach((g, i) => {
    assert.equal(
      stripVolatile(committed[i + 1].what),
      stripVolatile(g.what),
      `계열 ${g.key} 의 기재문이 커밋본과 다릅니다(원장이 코드와 갈렸다)`
    );
  });
});

await check('실측: 이 저장소 출고 본문에 정책 위반 잔존 0 (전수 재스캔)', () => {
  // 지시 3항 — 대조 대상은 머리말이 아니라 「모델이 실제로 받는 것」이다.
  const r = scanBodyPolicy(SKILLS_ROOT);
  assert.deepEqual(r.clarify, [], `부재 도구 지시 잔존: ${r.clarify.join(', ')}`);
  assert.deepEqual(r.payment, [], `경계 충돌 잔존: ${r.payment.join(', ')}`);
});

await check('--check-upstream: 고정본이 최신이면 차이 0 으로 보고한다', async () => {
  const { doc } = loadAllowlist();
  const pinned = doc.source.commit;
  const r = await checkUpstream({ fetchJson: async () => ({ sha: pinned }) });
  assert.equal(r.latest, pinned);
  assert.equal(r.behind, 0);
  assert.deepEqual(r.changed, []);
});

await check('--check-upstream: 뒤처졌으면 변경된 최상위 항목을 접어서 보고한다', async () => {
  const fetchJson = async (url) =>
    url.includes('/compare/')
      ? {
          ahead_by: 3,
          behind_by: 0,
          total_commits: 3,
          files: [
            { filename: 'korean-humanizer/instruction.md' },
            { filename: 'korean-humanizer/SKILL.md' }, // 같은 스킬은 하나로 접힌다
            { filename: 'new-skill/SKILL.md' },
          ],
        }
      : { sha: 'f'.repeat(40) };
  const r = await checkUpstream({ fetchJson });
  assert.equal(r.latest, 'f'.repeat(40));
  assert.equal(r.ahead, 3);
  assert.deepEqual(r.changed, ['korean-humanizer', 'new-skill']);
});

await check('--check-upstream 은 읽기 전용 — 설치본을 건드리지 않는다', async () => {
  // 자동 갱신 지름길이 생기면 채택 게이트(재검사·면제 재발행)가 무력화된다.
  const manifest = path.join(SKILLS_ROOT, '.claude-plugin', 'plugin.json');
  const before = fs.existsSync(manifest) ? fs.readFileSync(manifest, 'utf8') : null;
  await checkUpstream({ fetchJson: async () => ({ sha: 'f'.repeat(40), files: [], ahead_by: 1 }) });
  const after = fs.existsSync(manifest) ? fs.readFileSync(manifest, 'utf8') : null;
  assert.equal(after, before, '매니페스트가 바뀌었습니다');
});

await check('실측: 이 저장소의 스킬 정합', () => {
  // 스킬 미설치 클론에서도 도는 테스트 — 그때는 none 이 정답이다.
  const r = verifySkills();
  assert.ok(['ok', 'none'].includes(r.status), `정합 실패: ${JSON.stringify(r.checks?.filter((c) => !c.ok))}`);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed}개 통과${process.exitCode ? ' · 실패 있음' : ''}`);
