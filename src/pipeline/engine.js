import { EventEmitter } from 'node:events';
import { PROVIDERS, runProvider } from '../providers/index.js';

/**
 * 마스터 위임 파이프라인.
 *
 *   ① 계획   마스터(claude)가 작업을 단계로 쪼개고 각 단계를 어느 프로바이더에 맡길지 정한다
 *   ② 실행   의존성이 없는 단계끼리 병렬로 돈다(DAG 배치 실행)
 *   ③ 취합   마스터가 모든 단계 산출물을 하나의 답으로 합친다
 *
 * 엔진은 UI 를 모른다. 진행 상황은 이벤트로만 흘리고, CLI 든 Electron 이든
 * 같은 이벤트를 구독해 그린다 — 화면이 바뀌어도 엔진은 그대로다.
 *
 * 이벤트: plan:start plan:done step:start step:done step:error batch:start run:done run:error
 */

export const MAX_STEPS = 12;

/** 계획 요청 프롬프트. 모델 능력에 의존하지 않도록 형식을 엄격히 못박는다. */
export function buildPlanPrompt(task, { cwd, providers = Object.values(PROVIDERS) } = {}) {
  const roster = providers.map((p) => `- ${p.id}: ${p.role}`).join('\n');
  return `You are the master orchestrator of a multi-agent coding system.
Break the user's task into 1-${MAX_STEPS} steps and assign each to one agent.

Available agents:
${roster}

Working directory: ${cwd}

Rules:
- Assign research/search to gemini, code review to codex, coding and judgment to claude.
- Steps with no dependency run in PARALLEL, so keep independent work in separate steps.
- Use dependsOn only when a step genuinely needs an earlier step's output.
- Each prompt must be self-contained: the assigned agent sees only that prompt
  (plus the outputs of the steps it depends on).
- If the task is simple, one step is correct. Do not invent work.

Reply with ONLY this JSON, no prose, no code fence:
{"steps":[{"id":"s1","to":"claude","prompt":"...","dependsOn":[]}]}

Task:
${task}`;
}

/** 계획 텍스트 → 검증된 steps. 형식 위반은 예외로 올린다(무음 진행 금지). */
export function parsePlan(text) {
  const i = text.indexOf('{');
  const j = text.lastIndexOf('}');
  if (i < 0 || j < i) throw new Error('계획에서 JSON 을 찾지 못했습니다');
  let d;
  try {
    d = JSON.parse(text.slice(i, j + 1));
  } catch (e) {
    throw new Error(`계획 JSON 파싱 실패: ${e.message}`);
  }
  const steps = d.steps;
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('steps 가 비어 있습니다');
  if (steps.length > MAX_STEPS) throw new Error(`단계가 너무 많습니다: ${steps.length} > ${MAX_STEPS}`);

  const ids = new Set();
  for (const s of steps) {
    if (!s || typeof s.id !== 'string' || !s.id.trim()) throw new Error('step.id 가 필요합니다');
    if (ids.has(s.id)) throw new Error(`중복 step.id: ${s.id}`);
    ids.add(s.id);
    if (!PROVIDERS[s.to]) throw new Error(`알 수 없는 프로바이더: ${s.to} (step ${s.id})`);
    if (typeof s.prompt !== 'string' || !s.prompt.trim()) {
      throw new Error(`step.prompt 가 비었습니다: ${s.id}`);
    }
    s.dependsOn = Array.isArray(s.dependsOn) ? s.dependsOn : [];
  }
  for (const s of steps) {
    for (const d2 of s.dependsOn) {
      if (!ids.has(d2)) throw new Error(`알 수 없는 의존: ${s.id} → ${d2}`);
      if (d2 === s.id) throw new Error(`자기 자신에 의존: ${s.id}`);
    }
  }
  return steps;
}

/** 의존성 배치로 나눈다. 같은 배치 안의 단계는 병렬 실행 대상이다. */
export function toBatches(steps) {
  const done = new Set();
  const remaining = [...steps];
  const batches = [];
  while (remaining.length) {
    const ready = remaining.filter((s) => s.dependsOn.every((d) => done.has(d)));
    if (ready.length === 0) {
      throw new Error(`순환 의존 감지: ${remaining.map((s) => s.id).join(', ')}`);
    }
    batches.push(ready);
    for (const s of ready) done.add(s.id);
    for (const s of ready) remaining.splice(remaining.indexOf(s), 1);
  }
  return batches;
}

/** 의존 단계 산출물을 프롬프트 앞에 붙인다. */
export function composeStepPrompt(step, results) {
  const deps = step.dependsOn.map((id) => results[id]).filter(Boolean);
  if (!deps.length) return step.prompt;
  const ctx = deps
    .map((r) => `<result from="${r.provider}" step="${r.id}">\n${r.text}\n</result>`)
    .join('\n\n');
  return `${ctx}\n\n${step.prompt}`;
}

export function buildSynthesisPrompt(task, results) {
  const body = Object.values(results)
    .map((r) => `<step id="${r.id}" agent="${r.provider}">\n${r.text}\n</step>`)
    .join('\n\n');
  return `You are the master orchestrator. Below are the outputs of the agents you delegated to.
Synthesize one final answer for the user. Resolve contradictions explicitly; do not just concatenate.
Answer in the user's language. Be concise and lead with the outcome.

Original task:
${task}

Agent outputs:
${body}`;
}

export class Pipeline extends EventEmitter {
  /**
   * @param {object} cfg  설정(cwd, master, providerModels …)
   * @param {object} ledger 토큰 원장
   * @param {function} [call] 프로바이더 호출자 주입(테스트용 — 기본은 실제 CLI 호출)
   */
  /**
   * @param {object} sessions 프로바이더별 세션 id 보관함(호출자가 소유해 영속화한다)
   */
  constructor(cfg, ledger, call, sessions = {}) {
    super();
    this.cfg = cfg;
    this.ledger = ledger;
    this.sessions = sessions;
    this.call =
      call ||
      ((id, prompt, meta) =>
        runProvider(id, prompt, {
          cwd: cfg.cwd,
          model: cfg.providerModels?.[id] || undefined,
          session: meta?.session,
          claudeConfigDir: cfg.claudeConfigDir || undefined,
        }));
  }

  /**
   * @param {boolean} [opts.keepSession] 마스터 대화만 세션을 이어붙인다.
   *   단계 호출까지 같은 세션을 쓰면 병렬 단계가 한 세션을 동시에 물어 충돌한다.
   */
  async #ask(id, prompt, opts = {}) {
    const t0 = Date.now();
    const session = opts.keepSession ? this.sessions[id] : undefined;
    const res = await this.call(id, prompt, { ...opts, session });
    if (opts.keepSession && res.session) {
      this.sessions[id] = res.session;
      this.emit('session', { provider: id, session: res.session });
    }
    this.ledger?.addExternal(res.model || `cli:${id}`, res.usage);
    return { ...res, ms: Date.now() - t0 };
  }

  /** 작업 1건을 계획→병렬실행→취합까지 돌린다. */
  async run(task) {
    const master = this.cfg.master || 'claude';
    try {
      this.emit('plan:start', { master, task });
      const planRes = await this.#ask(master, buildPlanPrompt(task, { cwd: this.cfg.cwd }), {
        keepSession: true,
      });
      const steps = parsePlan(planRes.text);
      const batches = toBatches(steps);
      this.emit('plan:done', { steps, batches: batches.map((b) => b.map((s) => s.id)) });

      const results = {};
      for (let bi = 0; bi < batches.length; bi++) {
        const batch = batches[bi];
        this.emit('batch:start', { index: bi, total: batches.length, ids: batch.map((s) => s.id) });
        await Promise.all(
          batch.map(async (step) => {
            this.emit('step:start', { id: step.id, to: step.to, prompt: step.prompt });
            try {
              const r = await this.#ask(step.to, composeStepPrompt(step, results), { step });
              results[step.id] = { id: step.id, provider: step.to, text: r.text, ms: r.ms };
              this.emit('step:done', results[step.id]);
            } catch (e) {
              results[step.id] = {
                id: step.id,
                provider: step.to,
                text: `(실패: ${e.message})`,
                error: e.message,
              };
              this.emit('step:error', { id: step.id, to: step.to, error: e.message });
            }
          })
        );
      }

      const single = steps.length === 1 && !results[steps[0].id].error;
      const final = single
        ? results[steps[0].id].text // 단일 단계는 취합 호출을 생략한다(불필요한 왕복 제거)
        : (await this.#ask(master, buildSynthesisPrompt(task, results), { keepSession: true })).text;

      this.emit('run:done', { final, results, steps });
      return { final, results, steps };
    } catch (e) {
      this.emit('run:error', { error: e.message });
      throw e;
    }
  }
}
