const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,

  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  watchDirectory: () => ipcRenderer.invoke('duct:watchDirectory'),
  openDocument: (path, page, terms) => ipcRenderer.invoke('duct:openDocument', path, page, terms),
  openWorkspace: (left, right, page, terms) => ipcRenderer.invoke('duct:openWorkspace', left, right, page, terms),
  revealDocument: (path) => ipcRenderer.invoke('duct:revealDocument', path),
  onMenuAction: (callback) => ipcRenderer.on('menu:action', (_event, action) => callback(action)),
  showNotification: (title, body) => ipcRenderer.invoke('notification:show', title, body),
  getVersion: () => ipcRenderer.invoke('app:version'),
  getPrefs: () => ipcRenderer.invoke('prefs:get'),
  setPref: (name, on) => ipcRenderer.invoke('prefs:set', name, on),
  platform: process.platform,
})
