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

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed}개 통과${process.exitCode ? ' · 실패 있음' : ''}`);
