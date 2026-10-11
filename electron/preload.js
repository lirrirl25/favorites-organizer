const { contextBridge, ipcRenderer } = require('electron');
let cache = ipcRenderer.sendSync('store:load');
contextBridge.exposeInMainWorld('favStore', {
  isDesktop: true,
  dataDir: cache.dir,
  coverBase: cache.coverBase,
  get: (name) => cache[name],
  set: (name, obj) => { cache[name] = obj; return ipcRenderer.invoke('store:save', name, obj); },
  reload: (name) => { cache[name] = ipcRenderer.sendSync('store:reload', name); return cache[name]; },
  exportBackup: (text, defaultName) => ipcRenderer.invoke('backup:export', text, defaultName),
  openDataDir: () => ipcRenderer.invoke('open:dataDir'),
  openLog: () => ipcRenderer.invoke('open:log'),
  openPost: (platform, url) => ipcRenderer.invoke('open:post', platform, url),
  pending: {
    accept: (excludeKeys) => ipcRenderer.invoke('pending:accept', excludeKeys),
    discard: () => ipcRenderer.invoke('pending:discard'),
  },
  undoSync: () => ipcRenderer.invoke('sync:undo'),
  openDouyinApp: (url) => ipcRenderer.invoke('douyin:openApp', url),
  sync: {
    status: () => ipcRenderer.invoke('sync:status'),
    login: (platform) => ipcRenderer.invoke('sync:login', platform),
    start: (platform, opts) => ipcRenderer.invoke('sync:start', platform, opts),
    cancel: () => ipcRenderer.invoke('sync:cancel'),
    onProgress: (cb) => { const f = (_e, p) => cb(p); ipcRenderer.on('sync:progress', f); return () => ipcRenderer.removeListener('sync:progress', f); },
  },
});
