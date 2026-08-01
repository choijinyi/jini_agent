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
import { PROVIDERS, parseClaude, parseGemini, parseCodex, checkAuth, LOGIN } from './providers/index.js';
import { Pipeline, parsePlan, toBatches, composeStepPrompt } from './pipeline/engine.js';

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

await check('로그인 안내 명령이 프로바이더마다 정의돼 있다', () => {
  for (const id of ['claude', 'gemini', 'codex']) {
    assert.ok(LOGIN[id].command, id);
    assert.ok(LOGIN[id].guide, id);
    assert.ok(LOGIN[id].files.length, id);
  }
  assert.equal(LOGIN.claude.command, 'claude auth login');
  assert.equal(LOGIN.codex.command, 'codex login');
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

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed}개 통과${process.exitCode ? ' · 실패 있음' : ''}`);
