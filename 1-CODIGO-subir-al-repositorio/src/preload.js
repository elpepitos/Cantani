const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => {
  const handler = (_e, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),
  getDisplays: () => ipcRenderer.invoke('displays:get'),
  getState: () => ipcRenderer.invoke('state:get'),
  setDemo: (on_) => ipcRenderer.invoke('demo:set', !!on_),
  onSettings: (cb) => on('settings', cb),
  onTrack: (cb) => on('track', cb),
  onTiming: (cb) => on('timing', cb),
  onOffset: (cb) => on('offset', cb),
  onCalibrate: (cb) => on('calibrate', cb),
  onCalibrateFirst: (cb) => on('calibrateFirst', cb),
  copyReport: () => ipcRenderer.invoke('report:copy'),
  onDiag: (cb) => on('diag', cb),
  setOffset: (ms) => ipcRenderer.invoke('offset:set', ms),
  adjustOffset: (delta) => ipcRenderer.invoke('offset:adjust', delta),
  resetOffset: () => ipcRenderer.invoke('offset:reset')
});
