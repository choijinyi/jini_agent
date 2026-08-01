import readline from 'node:readline';
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig, apiKey, MODELS, DEFAULTS } from './config.js';
import { Ledger } from './agent/ledger.js';
import { createSession, runTurn } from './agent/loop.js';
import { buildTools } from './tools/registry.js';

const HELP = `Jini Agent — 토큰 최소화 코딩 에이전트

사용법
  jini                      대화형 세션 시작
  jini "작업 지시"           1회 실행 후 종료
  jini -p "작업 지시"        동일(파이프 친화)

플래그
  --model <id>       주 모델 (기본 ${DEFAULTS.model})
  --effort <level>   low|medium|high|xhigh|max (기본 ${DEFAULTS.effort})
  --max-tokens <n>   응답 상한 (기본 ${DEFAULTS.maxTokens})
  --yolo             쓰기·실행 도구 승인 생략
  --no-defer         도구 스키마 지연 로딩 끄기
  --no-context-edit  오래된 도구 결과 자동 비우기 끄기
  --help

세션 명령
  /cost   토큰·비용 원장     /model <id>  모델 교체
  /effort <lv>  노력 수준    /tools       적재된 도구
  /clear  대화 초기화        /exit        종료`;

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--yolo') flags.autoApprove = true;
    else if (a === '--no-defer') flags.deferTools = false;
    else if (a === '--no-context-edit') flags.contextEditing = false;
    else if (a === '--model') flags.model = argv[++i];
    else if (a === '--effort') flags.effort = argv[++i];
    else if (a === '--max-tokens') flags.maxTokens = Number(argv[++i]);
    else if (a === '-p' || a === '--prompt') rest.push(argv[++i]);
    else rest.push(a);
  }
  return { flags, prompt: rest.join(' ').trim() };
}

export async function main(argv) {
  const { flags, prompt } = parseArgs(argv);
  if (flags.help) {
    console.log(HELP);
    return;
  }

  const cfg = loadConfig(flags);
  const client = new Anthropic({ apiKey: apiKey() });
  const ledger = new Ledger();
  const session = createSession(cfg, client, ledger);

  if (prompt) {
    await runTurn(session, prompt, async () => cfg.autoApprove);
    console.error(`\x1b[90m${ledger.format()}\x1b[0m`);
    return;
  }

  console.log(
    `\x1b[1mJini Agent\x1b[0m  ${cfg.model} · effort=${cfg.effort} · ` +
      `defer=${cfg.deferTools} · ctx-edit=${cfg.contextEditing}\n` +
      `${cfg.cwd}\n/help 로 명령 목록.\n`
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));

  const approve = async (name, input) => {
    const s = JSON.stringify(input);
    const a = await ask(
      `\x1b[33m[승인] ${name} ${s.length > 200 ? s.slice(0, 197) + '...' : s}  (y/N) \x1b[0m`
    );
    return /^y(es)?$/i.test(a.trim());
  };

  for (;;) {
    const line = (await ask('\x1b[36m› \x1b[0m')).trim();
    if (!line) continue;

    if (line.startsWith('/')) {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      const arg = rest.join(' ');
      if (cmd === 'exit' || cmd === 'quit') break;
      if (cmd === 'help') { console.log(HELP); continue; }
      if (cmd === 'cost') { console.log(ledger.format()); continue; }
      if (cmd === 'clear') {
        session.messages.length = 0;
        session.turnIndex = 0;
        console.log('대화 초기화(원장은 유지).');
        continue;
      }
      if (cmd === 'tools') {
        console.log(
          session.tools
            .map((t) => `${t.name || t.type}${t.defer_loading ? ' (지연)' : ''}`)
            .join('\n')
        );
        continue;
      }
      if (cmd === 'model') {
        if (!MODELS[arg]) { console.log(`사용 가능: ${Object.keys(MODELS).join(', ')}`); continue; }
        cfg.model = arg;
        console.log(`모델 → ${arg} (프리픽스 캐시는 모델별이라 다시 채워집니다)`);
        continue;
      }
      if (cmd === 'effort') {
        if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(arg)) {
          console.log('low|medium|high|xhigh|max');
          continue;
        }
        cfg.effort = arg;
        console.log(`effort → ${arg}`);
        continue;
      }
      if (cmd === 'defer') {
        cfg.deferTools = arg !== 'off';
        session.tools = buildTools(cfg);
        console.log(`지연 로딩 → ${cfg.deferTools}`);
        continue;
      }
      console.log(`알 수 없는 명령: /${cmd}`);
      continue;
    }

    try {
      await runTurn(session, line, approve);
      console.log(`\x1b[90m${ledger.format()}\x1b[0m`);
    } catch (e) {
      console.error(`\x1b[31m[오류]\x1b[0m ${e.message}`);
    }
  }

  rl.close();
  console.log(ledger.format());
}
