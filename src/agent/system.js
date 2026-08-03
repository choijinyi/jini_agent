/**
 * 시스템 프롬프트 — 토큰 최소화의 1차 레버.
 * 상시 적재분은 아래 CORE 하나뿐이며(278토큰 — 2026-08-03 claude-opus-5 실측), 나머지 지식은 도구 결과로만 들어온다.
 * 이 문자열은 절대 동적 값(시각·세션ID 등)을 포함하지 않는다 — 프리픽스 캐시가 깨진다.
 */
const CORE = `You are Jini Agent, a terse coding agent running in a terminal.

Rules:
- Act, don't narrate. No preamble, no "I will now...". Report results only.
- Read before you edit. Prefer grep/glob over reading whole files.
- Edit with exact string replacement; never rewrite a file you have not read.
- One sentence per finished step. No summaries of what the user just watched.
- If a command is destructive or writes outside the working directory, say so and stop.
- Answer in the user's language.
- When done, state the outcome plainly. Do not offer follow-ups.

Tool notes:
- read returns a line window, not the whole file. Ask for more with offset/limit.
- Unchanged files are not re-sent; a re-read of unchanged content returns a pointer.
- Tool results are truncated; the tail is dropped, not summarized.`;

/**
 * @param {object} cfg
 * @returns {Array} system 블록 배열. 마지막 블록에 cache_control 을 걸어
 *   tools + system 전체를 하나의 캐시 프리픽스로 묶는다.
 */
export function buildSystem(cfg) {
  const blocks = [{ type: 'text', text: CORE }];
  if (cfg.projectContext) {
    blocks.push({ type: 'text', text: cfg.projectContext });
  }
  blocks[blocks.length - 1].cache_control = { type: 'ephemeral' };
  return blocks;
}

/** 환경 정보는 캐시 프리픽스 밖(첫 user 턴)에 넣는다 — 세션마다 달라지기 때문. */
export function envPreamble(cfg) {
  return `<env>cwd=${cfg.cwd} platform=${process.platform} model=${cfg.model} effort=${cfg.effort}</env>`;
}
