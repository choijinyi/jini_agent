import { MODELS } from '../config.js';

/**
 * 토큰 원장 — 요청마다 usage 를 누적하고 비용을 결정론적으로 산출한다.
 * 캐시 읽기(0.1x)·캐시 쓰기(1.25x)를 분리 계상해 캐시 효과를 실측한다.
 */
export class Ledger {
  constructor() {
    this.rows = [];
  }

  add(model, usage) {
    if (!usage) return;
    this.rows.push({
      model,
      input: usage.input_tokens || 0,
      output: usage.output_tokens || 0,
      cacheRead: usage.cache_read_input_tokens || 0,
      cacheWrite: usage.cache_creation_input_tokens || 0,
    });
  }

  totals() {
    const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: this.rows.length };
    for (const r of this.rows) {
      const p = MODELS[r.model] || { in: 0, out: 0 };
      t.input += r.input;
      t.output += r.output;
      t.cacheRead += r.cacheRead;
      t.cacheWrite += r.cacheWrite;
      t.cost +=
        (r.input * p.in + r.cacheWrite * p.in * 1.25 + r.cacheRead * p.in * 0.1 + r.output * p.out) /
        1_000_000;
    }
    return t;
  }

  /** 캐시 적중률 — 전체 입력 중 캐시에서 읽힌 비율. */
  hitRate() {
    const t = this.totals();
    const all = t.input + t.cacheRead + t.cacheWrite;
    return all === 0 ? 0 : t.cacheRead / all;
  }

  format() {
    const t = this.totals();
    return (
      `호출 ${t.calls} · 입력 ${t.input} (캐시읽기 ${t.cacheRead} · 캐시쓰기 ${t.cacheWrite}) · ` +
      `출력 ${t.output} · 캐시적중 ${(this.hitRate() * 100).toFixed(1)}% · 누적 $${t.cost.toFixed(4)}`
    );
  }
}
