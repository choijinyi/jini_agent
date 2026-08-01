import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { Ledger } from '../src/agent/ledger.js';
import { Pipeline } from '../src/pipeline/engine.js';
import { doctor, runProvider, PROVIDERS } from '../src/providers/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Electron 메인 프로세스.
 * 엔진(Pipeline)은 UI 를 모르고 이벤트만 흘린다 — 여기서 그 이벤트를 렌더러로 중계한다.
 * 렌더러는 Node 접근 권한이 없고(contextIsolation), preload 가 노출한 API 로만 대화한다.
 */

let win = null;
const ledger = new Ledger();
let cfg = loadConfig({ backend: 'cli' });

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
  createWindow();
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
}));

ipcMain.handle('jini:doctor', async () => doctor());

ipcMain.handle('jini:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return { cwd: cfg.cwd };
  cfg = { ...cfg, cwd: r.filePaths[0] };
  return { cwd: cfg.cwd };
});

ipcMain.handle('jini:ledger', async () => ({
  text: ledger.format(),
  totals: ledger.totals(),
}));

/** 파이프라인 실행 — 진행 상황을 이벤트로 중계한다. */
ipcMain.handle('jini:run', async (_e, { task }) => {
  const p = new Pipeline(cfg, ledger);
  for (const ev of ['plan:start', 'plan:done', 'batch:start', 'step:start', 'step:done', 'step:error']) {
    p.on(ev, (d) => send('jini:event', { type: ev, data: d }));
  }
  try {
    const out = await p.run(task);
    send('jini:event', { type: 'run:done', data: { final: out.final } });
    return { ok: true, final: out.final };
  } catch (err) {
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
