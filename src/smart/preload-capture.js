const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('smartApi', {
  hops: (d) => ipcRenderer.send('smart:hops', d),
  ready: () => ipcRenderer.send('smart:ready'),
  error: (m) => ipcRenderer.send('smart:error', m)
});
