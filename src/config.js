import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * 모델 카탈로그 — 가격은 $/1M 토큰 (Anthropic 1P API 기준).
 * 캐시 쓰기는 입력가의 1.25배(5분 TTL), 캐시 읽기는 0.1배.
 */
export const MODELS = {
  'claude-opus-5': { in: 5.0, out: 25.0, ctx: 1_000_000 },
  'claude-sonnet-5': { in: 3.0, out: 15.0, ctx: 1_000_000 },
  'claude-haiku-4-5': { in: 1.0, out: 5.0, ctx: 200_000 },
  'claude-opus-4-8': { in: 5.0, out: 25.0, ctx: 1_000_000 },
  'claude-fable-5': { in: 10.0, out: 50.0, ctx: 1_000_000 },
};

export const DEFAULTS = {
  // 백엔드: 'cli' = 계정 로그인된 벤더 CLI 를 헤드리스로 구동(기본·API 키 불요)
  //         'api' = Anthropic API 직접 호출(ANTHROPIC_API_KEY 필요)
  // API 키 경로는 프롬프트 캐싱·도구 지연 로딩·컨텍스트 편집을 쓸 수 있는 유일한 경로라
  // 선택지로 남겨둔다.
  backend: 'cli',
  // 마스터(오케스트레이션) 프로바이더. 나머지는 위임 대상.
  master: 'claude',
  // 프로바이더별 모델 고정(null = 각 CLI 의 기본값).
  providerModels: { claude: null, gemini: null, codex: null },
  // 주 모델(backend=api 일 때만 사용).
  model: 'claude-opus-5',
  // effort 자동 강등의 '짧은 입력' 기준(문자).
  shortInputChars: 280,
  // 한 턴에서 허용하는 최대 도구 호출 왕복.
  maxHops: 25,
  // 리모트 컨트롤 — 기본은 꺼짐, 켜도 localhost 로만 열린다.
  remote: { enabled: false, bind: 'localhost', port: 8765, token: '' },
  // effort: low | medium | high | xhigh | max — 토큰 예산의 1차 레버.
  effort: 'medium',
  maxTokens: 16000,
  // read 도구가 한 번에 반환하는 기본 줄 수. 파일 전문 적재를 막는다.
  readWindow: 200,
  // 도구 결과 1건당 문자 상한. 초과분은 잘라내고 포인터만 남긴다.
  toolResultCap: 8000,
  // 오래된 도구 결과를 서버에서 비우는 컨텍스트 편집(베타) 사용 여부.
  contextEditing: true,
  // 지연 로딩 도구 사용 여부(도구 스키마를 필요할 때만 컨텍스트에 올린다).
  deferTools: true,
  // 쓰기·실행 도구 승인 요구.
  autoApprove: false,
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 전역(~/.jini/config.json) → 프로젝트(.jini.json) → CLI 플래그 순으로 덮어쓴다. */
export function loadConfig(flags = {}) {
  const global = readJson(path.join(os.homedir(), '.jini', 'config.json')) || {};
  const project = readJson(path.join(process.cwd(), '.jini.json')) || {};
  const cfg = { ...DEFAULTS, ...global, ...project, ...flags };

  if (cfg.backend === 'api' && !MODELS[cfg.model]) {
    const known = Object.keys(MODELS).join(', ');
    throw new Error(`알 수 없는 모델: ${cfg.model} (사용 가능: ${known})`);
  }
  if (!['cli', 'api'].includes(cfg.backend)) {
    throw new Error(`알 수 없는 백엔드: ${cfg.backend} (cli | api)`);
  }
  cfg.cwd = process.cwd();
  return cfg;
}

export function apiKey() {
  const key = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  if (!key) {
    throw new Error(
      'ANTHROPIC_API_KEY 가 설정되지 않았습니다.\n' +
        '  PowerShell: $env:ANTHROPIC_API_KEY = "sk-ant-..."\n' +
        '  bash:       export ANTHROPIC_API_KEY=sk-ant-...'
    );
  }
  return key;
}
