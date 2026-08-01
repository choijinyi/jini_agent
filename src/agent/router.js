/**
 * effort 자동 조정.
 *
 * 강등 조건 3가지를 모두 만족할 때만 한 단계 낮춘다:
 *   ① 첫 턴일 것  ② 직전 턴에 도구를 쓰지 않았을 것  ③ 입력이 짧을 것
 * ③은 CSO 검수 §9 에서 "입력 길이를 보는 코드가 없다"고 지적돼 추가했다
 * (문서가 주장하던 동작을 코드가 실제로 하도록 맞춘 것이다).
 *
 * cfg.autoEffort=false 로 끌 수 있고, cfg.shortInputChars 로 기준을 조정한다.
 */
const LADDER = ['low', 'medium', 'high', 'xhigh', 'max'];

export function pickEffort(cfg, { turnIndex, lastUsedTools, inputLength = 0 }) {
  if (cfg.autoEffort === false) return cfg.effort;
  const i = LADDER.indexOf(cfg.effort);
  if (i <= 0) return cfg.effort;
  const short = inputLength <= (cfg.shortInputChars ?? 280);
  if (turnIndex === 0 && !lastUsedTools && short) return LADDER[i - 1];
  return cfg.effort;
}
