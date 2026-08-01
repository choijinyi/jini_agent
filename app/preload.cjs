const { contextBridge, ipcRenderer } = require('electron');

/**
 * 렌더러에 노출되는 유일한 표면.
 * 렌더러는 Node 도 파일시스템도 만지지 못하고, 아래 함수만 쓸 수 있다.
 */
contextBridge.exposeInMainWorld('jini', {
  init: () => ipcRenderer.invoke('jini:init'),
  doctor: () => ipcRenderer.invoke('jini:doctor'),
  pickFolder: () => ipcRenderer.invoke('jini:pickFolder'),
  listDir: () => ipcRenderer.invoke('jini:listDir'),
  login: (id) => ipcRenderer.invoke('jini:login', { id }),
  install: (id) => ipcRenderer.invoke('jini:install', { id }),
  settings: (action, key, value) => ipcRenderer.invoke('jini:settings', { action, key, value }),
  remote: () => ipcRenderer.invoke('jini:remote'),
  bg: (task) => ipcRenderer.invoke('jini:bg', { task }),
  agents: () => ipcRenderer.invoke('jini:agents'),
  master: () => ipcRenderer.invoke('jini:master'),
  openMaster: () => ipcRenderer.invoke('jini:openMaster'),
  newSession: () => ipcRenderer.invoke('jini:newSession'),
  ledger: () => ipcRenderer.invoke('jini:ledger'),
  run: (task) => ipcRenderer.invoke('jini:run', { task }),
  ask: (to, prompt) => ipcRenderer.invoke('jini:ask', { to, prompt }),
  onEvent: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('jini:event', h);
    return () => ipcRenderer.removeListener('jini:event', h);
  },
});
