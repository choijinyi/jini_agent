import { MODELS } from '../config.js';

/**
 * 모델 라우팅 — 주 루프는 항상 cfg.model 을 쓴다.
 * 아래 kind 는 '기계적'이라고 명시된 보조 호출에만 적용된다(요약·분류·커밋메시지 등).
 * 품질에 영향 있는 판단을 임의로 강등하지 않는다.
 */
const MECHANICAL = new Set(['summarize', 'classify', 'commit-message', 'triage']);

export function pickModel(cfg, kind = 'main') {
  if (kind === 'main') return cfg.model;
  if (MECHANICAL.has(kind) && MODELS[cfg.fastModel]) return cfg.fastModel;
  return cfg.model;
}

/**
 * effort 자동 조정: 입력이 짧고 도구 사용이 없던 단순 질의는 한 단계 낮춘다.
 * cfg.autoEffort=false 로 끌 수 있다.
 */
const LADDER = ['low', 'medium', 'high', 'xhigh', 'max'];

export function pickEffort(cfg, { turnIndex, lastUsedTools }) {
  if (cfg.autoEffort === false) return cfg.effort;
  const i = LADDER.indexOf(cfg.effort);
  if (i <= 0) return cfg.effort;
  if (turnIndex === 0 && !lastUsedTools) return LADDER[i - 1];
  return cfg.effort;
}
