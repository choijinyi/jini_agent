import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { Ledger } from '../src/agent/ledger.js';
import { Pipeline } from '../src/pipeline/engine.js';
import {
  doctor,
  runProvider,
  PROVIDERS,
  openLoginTerminal,
  openInstallTerminal,
} from '../src/providers/index.js';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Electron 메인 프로세스.
 * 엔진(Pipeline)은 UI 를 모르고 이벤트만 흘린다 — 여기서 그 이벤트를 렌더러로 중계한다.
 * 렌더러는 Node 접근 권한이 없고(contextIsolation), preload 가 노출한 API 로만 대화한다.
 */

let win = null;
const ledger = new Ledger();

/** 창은 어디서 실행되든(바로가기의 WorkingDirectory) 마지막에 고른 폴더를 기억한다. */
const stateFile = () => path.join(app.getPath('userData'), 'state.json');
const logFile = () => path.join(app.getPath('userData'), 'app.log');

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}\n`;
  try {
    fs.appendFileSync(logFile(), line);
  } catch { /* 로그 실패가 앱을 막지 않는다 */ }
  console.log(line.trim());
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return {};
  }
}

function saveState(patch) {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify({ ...loadState(), ...patch }, null, 2));
  } catch (e) {
    log('state 저장 실패:', e.message);
  }
}

let cfg = loadConfig({ backend: 'cli' });

process.on('uncaughtException', (e) => log('uncaughtException:', e.stack || e.message));
process.on('unhandledRejection', (e) => log('unhandledRejection:', e?.stack || String(e)));

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0e1116',
    title: 'Jini Agent',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(here, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  const saved = loadState().cwd;
  if (saved && fs.existsSync(saved)) cfg = { ...cfg, cwd: saved };
  log('시작 · cwd =', cfg.cwd, '· 로그 =', logFile());
  createWindow();
  syncRemote();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

const send = (channel, payload) => win?.webContents.send(channel, payload);

ipcMain.handle('jini:init', async () => ({
  cwd: cfg.cwd,
  master: cfg.master,
  providers: Object.values(PROVIDERS).map((p) => ({ id: p.id, role: p.role })),
  logPath: logFile(),
  // 홈 디렉터리를 작업 폴더로 두면 에이전트가 홈 전체를 훑다가 느려지거나 실패한다.
  isHome: path.resolve(cfg.cwd) === path.resolve(app.getPath('home')),
}));

ipcMain.handle('jini:doctor', async () => doctor());

// ── 리모트 컨트롤 ────────────────────────────────────────────────
let remote = null;

/** 설정에 맞춰 리모트 서버를 켜거나 끈다. 토큰이 없으면 만들어 저장한다. */
async function syncRemote() {
  const s = await import('../src/settings.js');
  const { createRemoteServer, genToken } = await import('../src/remote/server.js');
  const r = cfg.remote || {};

  if (remote) {
    await remote.stop();
    remote = null;
    log('리모트 중지');
  }
  if (!r.enabled) return null;

  let token = r.token;
  if (!token) {
    token = genToken();
    s.set('remote.token', token);
    cfg = { ...cfg, remote: { ...r, token } };
    log('리모트 토큰 자동 생성');
  }

  try {
    const srv = createRemoteServer({
      token,
      port: r.port || 8765,
      bind: r.bind || 'localhost',
      runTask: async (task, emit) => {
        const p = new Pipeline(cfg, ledger);
        for (const ev of ['plan:done', 'step:start', 'step:done', 'step:error']) {
          p.on(ev, (d) => {
            emit(ev, d);
            send('jini:event', { type: ev, data: d });
          });
        }
        send('jini:event', { type: 'remote:task', data: { task } });
        const out = await p.run(task);
        emit('run:done', { final: out.final });
        send('jini:event', { type: 'run:done', data: { final: out.final } });
        send('jini:event', { type: 'ledger', data: { text: ledger.format() } });
      },
    });
    const url = await srv.start();
    remote = srv;
    log('리모트 시작:', url);
    return url;
  } catch (e) {
    log('리모트 시작 실패:', e.message);
    return { error: e.message };
  }
}

ipcMain.handle('jini:remote', async () => {
  const r = cfg.remote || {};
  return {
    enabled: Boolean(r.enabled),
    running: Boolean(remote),
    url: remote ? remote.url : null,
    bind: r.bind || 'localhost',
    port: r.port || 8765,
  };
});

ipcMain.handle('jini:settings', async (_e, { action, key, value } = {}) => {
  const s = await import('../src/settings.js');
  try {
    if (action === 'set') {
      const v = s.set(key, value);
      // 저장 즉시 실행 설정에 반영한다(창을 다시 열지 않아도 된다).
      const cwd = cfg.cwd;
      cfg = { ...loadConfig({ backend: 'cli' }), cwd };
      log('설정 변경:', key, '=', JSON.stringify(v));
      if (key.startsWith('remote.')) await syncRemote();
      return { ok: true, rows: s.list(), path: s.userConfigPath() };
    }
    if (action === 'reset') {
      s.reset(key);
      const cwd = cfg.cwd;
      cfg = { ...loadConfig({ backend: 'cli' }), cwd };
      log('설정 초기화:', key);
      return { ok: true, rows: s.list(), path: s.userConfigPath() };
    }
    return { ok: true, rows: s.list(), path: s.userConfigPath() };
  } catch (e) {
    return { ok: false, error: e.message, rows: s.list(), path: s.userConfigPath() };
  }
});

ipcMain.handle('jini:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: '작업할 폴더 선택',
  });
  if (r.canceled || !r.filePaths[0]) return { cwd: cfg.cwd, ...listDir(cfg.cwd) };
  cfg = { ...cfg, cwd: r.filePaths[0] };
  saveState({ cwd: cfg.cwd });
  log('작업 폴더 변경:', cfg.cwd);
  return { cwd: cfg.cwd, ...listDir(cfg.cwd) };
});

/** 선택한 폴더의 얕은 목록 — 무엇을 대상으로 작업하는지 눈으로 확인시킨다. */
function listDir(dir) {
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv']);
  try {
    const all = fs.readdirSync(dir, { withFileTypes: true });
    const entries = all
      .filter((e) => !e.name.startsWith('.') && !SKIP.has(e.name))
      .map((e) => ({ name: e.name, dir: e.isDirectory() }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    return { entries: entries.slice(0, 200), total: all.length, error: null };
  } catch (e) {
    return { entries: [], total: 0, error: e.message };
  }
}

ipcMain.handle('jini:listDir', async () => ({ cwd: cfg.cwd, ...listDir(cfg.cwd) }));

ipcMain.handle('jini:login', async (_e, { id }) => {
  try {
    return { ok: true, ...openLoginTerminal(id) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('jini:install', async (_e, { id }) => {
  try {
    return { ok: true, ...openInstallTerminal(id) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('jini:ledger', async () => ({
  text: ledger.format(),
  totals: ledger.totals(),
}));

/** 파이프라인 실행 — 진행 상황을 이벤트로 중계한다. */
ipcMain.handle('jini:run', async (_e, { task }) => {
  const p = new Pipeline(cfg, ledger);
  for (const ev of ['plan:start', 'plan:done', 'batch:start', 'step:start', 'step:done', 'step:error']) {
    p.on(ev, (d) => {
      send('jini:event', { type: ev, data: d });
      // 원장은 실행이 끝난 뒤가 아니라 매 이벤트마다 밀어준다 —
      // 계획 호출부터 값이 잡히므로 진행 중에도 토큰·비용이 움직인다.
      send('jini:event', { type: 'ledger', data: { text: ledger.format() } });
    });
  }
  log('run 시작 · cwd =', cfg.cwd, '· task =', task.slice(0, 120));
  try {
    const out = await p.run(task);
    send('jini:event', { type: 'run:done', data: { final: out.final } });
    return { ok: true, final: out.final };
  } catch (err) {
    log('run 실패:', err.stack || err.message);
    send('jini:event', { type: 'run:error', data: { error: err.message } });
    return { ok: false, error: err.message };
  } finally {
    send('jini:event', { type: 'ledger', data: { text: ledger.format() } });
  }
});

/** 단일 프로바이더 직접 호출(파이프라인 우회). */
ipcMain.handle('jini:ask', async (_e, { to, prompt }) => {
  send('jini:event', { type: 'step:start', data: { id: 'direct', to, prompt } });
  try {
    const r = await runProvider(to, prompt, { cwd: cfg.cwd });
    ledger.addExternal(r.model || `cli:${to}`, r.usage);
    send('jini:event', { type: 'step:done', data: { id: 'direct', provider: to, text: r.text } });
    send('jini:event', { type: 'ledger', data: { text: ledger.format() } });
    return { ok: true, text: r.text };
  } catch (err) {
    send('jini:event', { type: 'step:error', data: { id: 'direct', to, error: err.message } });
    return { ok: false, error: err.message };
  }
});
