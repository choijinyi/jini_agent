/**
 * 도구 레지스트리.
 *
 * 토큰 최소화 지점 두 가지:
 *  1) 설명문을 한 줄로 유지한다. 도구 스키마는 매 요청 프리픽스에 실린다.
 *  2) 상시 필요하지 않은 도구는 defer_loading 으로 선언만 하고, 모델이
 *     tool_search 로 호출할 때 스키마가 컨텍스트에 올라온다.
 */

const str = (description) => ({ type: 'string', description });

export const CORE_TOOLS = [
  {
    name: 'read',
    description: 'Read a line window of a file. Returns numbered lines.',
    input_schema: {
      type: 'object',
      properties: {
        path: str('File path'),
        offset: { type: 'integer', description: '1-based start line' },
        limit: { type: 'integer', description: 'Line count' },
      },
      required: ['path'],
    },
  },
  {
    name: 'edit',
    description: 'Replace an exact string in a file. Fails unless it matches once.',
    input_schema: {
      type: 'object',
      properties: {
        path: str('File path'),
        old: str('Exact text to replace'),
        new: str('Replacement text'),
        all: { type: 'boolean', description: 'Replace every occurrence' },
      },
      required: ['path', 'old', 'new'],
    },
  },
  {
    name: 'write',
    description: 'Write a file, overwriting it.',
    input_schema: {
      type: 'object',
      properties: { path: str('File path'), content: str('Full contents') },
      required: ['path', 'content'],
    },
  },
  {
    name: 'grep',
    description: 'Regex search across files. Returns path:line:text.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: str('Regex'),
        path: str('Directory or file to search'),
        glob: str('Filter like **/*.js'),
        max: { type: 'integer', description: 'Max matches (default 60)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'glob',
    description: 'List files matching a glob pattern.',
    input_schema: {
      type: 'object',
      properties: { pattern: str('e.g. src/**/*.js'), path: str('Base directory') },
      required: ['pattern'],
    },
  },
  {
    name: 'bash',
    description: 'Run a shell command in the working directory.',
    input_schema: {
      type: 'object',
      properties: {
        command: str('Command line'),
        timeout: { type: 'integer', description: 'Milliseconds (default 60000)' },
      },
      required: ['command'],
    },
  },
];

/** 지연 로딩 도구 — 선언만 되고, 필요할 때 tool_search 로 끌어올려진다. */
export const DEFERRED_TOOLS = [
  {
    name: 'git',
    description: 'Run a read-only git subcommand (status, log, diff, show, blame).',
    input_schema: {
      type: 'object',
      properties: { args: str('e.g. "log --oneline -10"') },
      required: ['args'],
    },
  },
  {
    name: 'ls',
    description: 'List a directory with sizes.',
    input_schema: {
      type: 'object',
      properties: { path: str('Directory') },
      required: ['path'],
    },
  },
  {
    name: 'count_tokens',
    description: 'Count tokens of a file or string against the current model.',
    input_schema: {
      type: 'object',
      properties: { path: str('File path'), text: str('Raw text') },
      required: [],
    },
  },
];

const TOOL_SEARCH = { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' };

/**
 * 요청에 실을 tools 배열을 만든다.
 * deferTools=false 이면 전 도구를 즉시 로드한다(왕복 1회 절약, 프리픽스 증가).
 */
export function buildTools(cfg) {
  if (!cfg.deferTools) return [...CORE_TOOLS, ...DEFERRED_TOOLS];
  return [
    TOOL_SEARCH,
    ...CORE_TOOLS,
    ...DEFERRED_TOOLS.map((t) => ({ ...t, defer_loading: true })),
  ];
}

/** 승인이 필요한 도구(쓰기·실행). */
export const NEEDS_APPROVAL = new Set(['write', 'edit', 'bash']);
