import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULTS, MODELS } from './config.js';

/**
 * 설정 스키마 — CLI(`jini config`)와 창(⚙)이 같은 정의를 공유한다.
 * 여기에만 키를 추가하면 양쪽 UI 와 검증이 동시에 따라온다.
 *
 * scope: 'cli' = 계정 로그인 백엔드에서 의미 있음 · 'api' = --backend api 전용 · 'both'
 */
export const SCHEMA = {
  master: {
    type: 'choice',
    choices: ['claude', 'gemini', 'codex'],
    label: '마스터(작업을 쪼개고 취합하는 AI)',
    scope: 'cli',
  },
  backend: {
    type: 'choice',
    choices: ['cli', 'api'],
    label: '백엔드 (cli=계정 로그인 · api=키 직접)',
    scope: 'both',
  },
  autoApprove: {
    type: 'bool',
    label: '쓰기·실행 도구 승인 생략',
    scope: 'both',
  },
  'remote.enabled': {
    type: 'bool',
    label: '리모트 컨트롤 (폰·다른 PC 브라우저에서 조종)',
    scope: 'both',
  },
  'remote.bind': {
    type: 'choice',
    choices: ['localhost', 'lan'],
    label: '접속 범위 (localhost=이 PC만 · lan=같은 네트워크)',
    scope: 'both',
  },
  'remote.port': { type: 'int', min: 1024, max: 65535, label: '리모트 포트', scope: 'both' },
  'remote.token': {
    type: 'string',
    label: '접속 토큰 (비우면 켤 때 자동 생성)',
    scope: 'both',
  },
  claudeConfigDir: {
    type: 'string',
    label: 'claude 설정 폴더 고정(빈값=기본 프로필 — 폰 앱 연동은 이 값이어야 함)',
    scope: 'cli',
  },
  'providerModels.claude': { type: 'string', label: 'claude 모델 고정(빈값=CLI 기본)', scope: 'cli' },
  'providerModels.gemini': { type: 'string', label: 'gemini 모델 고정(빈값=CLI 기본)', scope: 'cli' },
  'providerModels.codex': { type: 'string', label: 'codex 모델 고정(빈값=CLI 기본)', scope: 'cli' },
  readWindow: { type: 'int', min: 20, max: 5000, label: 'read 도구가 한 번에 읽는 줄 수', scope: 'api' },
  toolResultCap: { type: 'int', min: 500, max: 200000, label: '도구 결과 상한(문자)', scope: 'api' },
  maxHops: { type: 'int', min: 1, max: 100, label: '한 턴 최대 도구 호출 횟수', scope: 'api' },
  model: { type: 'choice', choices: Object.keys(MODELS), label: 'API 백엔드 모델', scope: 'api' },
  effort: {
    type: 'choice',
    choices: ['low', 'medium', 'high', 'xhigh', 'max'],
    label: 'effort(사고 깊이)',
    scope: 'api',
  },
  maxTokens: { type: 'int', min: 256, max: 128000, label: '응답 토큰 상한', scope: 'api' },
  shortInputChars: { type: 'int', min: 0, max: 5000, label: 'effort 자동 강등 기준(문자)', scope: 'api' },
  deferTools: { type: 'bool', label: '도구 스키마 지연 로딩', scope: 'api' },
  contextEditing: { type: 'bool', label: '서버측 컨텍스트 편집', scope: 'api' },
};

export const userConfigPath = () => path.join(os.homedir(), '.jini', 'config.json');

export function readUser() {
  try {
    return JSON.parse(fs.readFileSync(userConfigPath(), 'utf8'));
  } catch {
    return {};
  }
}

function getPath(obj, key) {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, key, value) {
  const parts = key.split('.');
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

/** 문자열 입력을 스키마에 맞는 값으로 바꾼다. 어긋나면 예외(무음 저장 금지). */
export function coerce(key, raw) {
  const s = SCHEMA[key];
  if (!s) throw new Error(`알 수 없는 설정 키: ${key}`);
  const v = typeof raw === 'string' ? raw.trim() : raw;

  if (s.type === 'bool') {
    if (typeof v === 'boolean') return v;
    if (/^(true|on|yes|1)$/i.test(v)) return true;
    if (/^(false|off|no|0)$/i.test(v)) return false;
    throw new Error(`${key}: true/false 만 가능합니다`);
  }
  if (s.type === 'int') {
    const n = Number(v);
    if (!Number.isInteger(n)) throw new Error(`${key}: 정수여야 합니다`);
    if (s.min != null && n < s.min) throw new Error(`${key}: 최소 ${s.min}`);
    if (s.max != null && n > s.max) throw new Error(`${key}: 최대 ${s.max}`);
    return n;
  }
  if (s.type === 'choice') {
    if (!s.choices.includes(v)) throw new Error(`${key}: ${s.choices.join(' | ')} 중 하나`);
    return v;
  }
  return String(v);
}

/** 현재 유효값(기본값 + 사용자 설정)을 스키마 순서대로 나열한다. */
export function list() {
  const user = readUser();
  return Object.entries(SCHEMA).map(([key, s]) => {
    const userVal = getPath(user, key);
    const effective = userVal !== undefined ? userVal : getPath(DEFAULTS, key);
    return {
      key,
      label: s.label,
      type: s.type,
      choices: s.choices || null,
      scope: s.scope,
      value: effective === undefined ? '' : effective,
      isDefault: userVal === undefined,
    };
  });
}

/** 값 하나를 사용자 설정 파일에 저장한다. 반환값은 저장된 실제 값. */
export function set(key, raw) {
  const value = coerce(key, raw);
  const user = readUser();
  setPath(user, key, value);
  fs.mkdirSync(path.dirname(userConfigPath()), { recursive: true });
  fs.writeFileSync(userConfigPath(), JSON.stringify(user, null, 2));
  return value;
}

/** 사용자 설정에서 키를 지워 기본값으로 되돌린다. */
export function reset(key) {
  if (!SCHEMA[key]) throw new Error(`알 수 없는 설정 키: ${key}`);
  const user = readUser();
  const parts = key.split('.');
  let cur = user;
  for (const p of parts.slice(0, -1)) {
    if (typeof cur?.[p] !== 'object') return false;
    cur = cur[p];
  }
  const last = parts[parts.length - 1];
  if (cur && last in cur) {
    delete cur[last];
    fs.writeFileSync(userConfigPath(), JSON.stringify(user, null, 2));
    return true;
  }
  return false;
}
