const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,

  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  watchDirectory: () => ipcRenderer.invoke('duct:watchDirectory'),
  onMenuAction: (callback) => ipcRenderer.on('menu:action', (_event, action) => callback(action)),
  showNotification: (title, body) => ipcRenderer.invoke('notification:show', title, body),
  getVersion: () => ipcRenderer.invoke('app:version'),
  platform: process.platform,
})
