const { contextBridge, ipcRenderer } = require('electron');

// Read-only, hand-picked surface. The renderer can pull the current snapshot,
// subscribe to pushes, and fire a few intents -- but never touch the filesystem
// or arbitrary IPC channels.
contextBridge.exposeInMainWorld('usageAPI', {
  get: () => ipcRenderer.invoke('usage:get'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  refresh: () => ipcRenderer.invoke('usage:refresh'),
  openConfig: () => ipcRenderer.invoke('app:openConfig'),
  quit: () => ipcRenderer.invoke('app:quit'),
  onUpdate: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('usage:update', handler);
    return () => ipcRenderer.removeListener('usage:update', handler);
  },
});
