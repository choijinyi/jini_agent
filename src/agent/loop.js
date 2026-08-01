import { buildSystem, envPreamble } from './system.js';
import { buildTools, NEEDS_APPROVAL } from '../tools/registry.js';
import { execTool } from '../tools/exec.js';
import { pickEffort } from './router.js';

/**
 * 대화 상태. messages 는 API 에 그대로 실리는 배열이며,
 * 캐시 프리픽스를 깨지 않기 위해 과거 항목은 절대 수정하지 않는다
 * (cache_control 마커만 예외적으로 이동시킨다).
 */
export function createSession(cfg, client, ledger) {
  return {
    cfg,
    client,
    ledger,
    messages: [],
    system: buildSystem(cfg),
    tools: buildTools(cfg),
    turnIndex: 0,
    lastUsedTools: false,
  };
}

/**
 * 캐시 브레이크포인트 재배치.
 * 요청당 최대 4개이므로, system 1개 + 직전 user 턴 1개 + 현재 user 턴 1개만 유지한다.
 * 직전 턴을 남기는 이유: 현재 턴이 캐시 미스여도 이전 프리픽스는 읽기로 회수된다.
 */
export function applyCacheBreakpoints(messages) {
  const userIdx = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) delete b.cache_control;
    if (m.role === 'user') userIdx.push(i);
  }
  for (const i of userIdx.slice(-2)) {
    const c = messages[i].content;
    if (Array.isArray(c) && c.length) c[c.length - 1].cache_control = { type: 'ephemeral' };
  }
}

function betaParams(cfg) {
  if (!cfg.contextEditing) return {};
  return {
    betas: ['context-management-2025-06-27'],
    context_management: { edits: [{ type: 'clear_tool_uses_20250919' }] },
  };
}

async function callModel(session, params) {
  const { client } = session;
  const useBeta = Boolean(params.betas);
  const ns = useBeta ? client.beta.messages : client.messages;

  if (typeof ns.stream === 'function') {
    const stream = ns.stream(params);
    stream.on('text', (d) => process.stdout.write(d));
    const msg = await stream.finalMessage();
    process.stdout.write('\n');
    return msg;
  }
  const msg = await ns.create(params);
  for (const b of msg.content) if (b.type === 'text') process.stdout.write(b.text + '\n');
  return msg;
}

/**
 * 한 사용자 입력에 대한 완결 턴. 도구 호출이 끝날 때까지 루프를 돈다.
 * @param {(name:string, input:object)=>Promise<boolean>} approve 승인 콜백
 */
export async function runTurn(session, userInput, approve) {
  const { cfg, ledger } = session;
  const first = session.messages.length === 0;
  const text = first ? `${envPreamble(cfg)}\n${userInput}` : userInput;
  session.messages.push({ role: 'user', content: [{ type: 'text', text }] });

  let usedTools = false;
  const maxHops = cfg.maxHops || 25;
  let hop = 0;

  for (; hop < maxHops; hop++) {
    applyCacheBreakpoints(session.messages);

    const params = {
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      system: session.system,
      tools: session.tools,
      messages: session.messages,
      output_config: {
        effort: pickEffort(cfg, { turnIndex: session.turnIndex, lastUsedTools: session.lastUsedTools }),
      },
      ...betaParams(cfg),
    };

    const msg = await callModel(session, params);
    ledger.add(cfg.model, msg.usage);
    session.messages.push({ role: 'assistant', content: msg.content });

    if (msg.stop_reason === 'refusal') {
      console.log('\x1b[33m[jini] 모델이 이 요청을 거부했습니다(안전 분류기).\x1b[0m');
      break;
    }
    if (msg.stop_reason === 'pause_turn') continue; // 서버 도구 재개
    if (msg.stop_reason === 'max_tokens') {
      console.log('\x1b[33m[jini] max_tokens 도달 — 출력이 잘렸습니다.\x1b[0m');
      break;
    }
    if (msg.stop_reason !== 'tool_use') break;

    const calls = msg.content.filter((b) => b.type === 'tool_use');
    if (calls.length === 0) {
      // stop_reason 이 tool_use 인데 블록이 없으면 빈 user 메시지를 만들지 않고 종료한다
      // (빈 content 는 400) — reviewer-gemini 지적 ①-4.
      console.log('\x1b[33m[jini] tool_use 로 멈췄으나 도구 호출 블록이 없습니다 — 턴 종료.\x1b[0m');
      break;
    }
    const results = [];
    for (const call of calls) {
      usedTools = true;
      let out;
      let isError = false;
      try {
        if (NEEDS_APPROVAL.has(call.name) && !cfg.autoApprove) {
          const ok = await approve(call.name, call.input);
          if (!ok) throw new Error('사용자가 이 도구 실행을 거부했습니다');
        }
        console.log(`\x1b[90m  · ${call.name} ${summarize(call.input)}\x1b[0m`);
        out = await execTool(call.name, call.input, cfg, session);
      } catch (e) {
        out = `error: ${e.message}`;
        isError = true;
      }
      results.push({ type: 'tool_result', tool_use_id: call.id, content: out, is_error: isError });
    }
    session.messages.push({ role: 'user', content: results });
  }

  if (hop >= maxHops) {
    // 무음 종료 금지 — 상한 도달을 사용자에게 알린다(reviewer-gemini 지적 ④-1).
    console.log(
      `\x1b[33m[jini] 도구 호출 상한 ${maxHops}회 도달 — 턴을 종료합니다. ` +
        `이어서 진행하려면 다시 지시하세요(설정: maxHops).\x1b[0m`
    );
  }

  session.turnIndex++;
  session.lastUsedTools = usedTools;
}

function summarize(input) {
  const s = JSON.stringify(input ?? {});
  return s.length > 120 ? s.slice(0, 117) + '...' : s;
}
