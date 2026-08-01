/**
 * API 키 없이 도는 자기검증. `npm run selftest`
 * 네트워크를 타는 경로(count_tokens, 모델 호출)는 제외한다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execTool } from './tools/exec.js';
import { buildTools, CORE_TOOLS } from './tools/registry.js';
import { applyCacheBreakpoints } from './agent/loop.js';
import { Ledger } from './agent/ledger.js';
import { DEFAULTS } from './config.js';
import { buildSystem } from './agent/system.js';
import { PROVIDERS, parseClaude, parseGemini, parseCodex } from './providers/index.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jini-'));
const cfg = { ...DEFAULTS, cwd: tmp, model: 'claude-opus-5' };
let passed = 0;
const check = (name, fn) => {
  try {
    const r = fn();
    return r instanceof Promise
      ? r.then(() => { console.log(`  ok  ${name}`); passed++; })
      : (console.log(`  ok  ${name}`), passed++, Promise.resolve());
  } catch (e) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exitCode = 1;
    return Promise.resolve();
  }
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

await check('경로 탈출 거부', async () => {
  await assert.rejects(() => execTool('read', { path: '../../etc/hosts' }, cfg, {}));
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

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed}개 통과${process.exitCode ? ' · 실패 있음' : ''}`);
