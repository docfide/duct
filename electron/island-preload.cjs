const { contextBridge, ipcRenderer, webUtils } = require('electron')

// The island page gets only these calls; the main process validates everything it receives.
contextBridge.exposeInMainWorld('ductIsland', {
  setShape: (rect, wantsKeyboard) => ipcRenderer.send('island:shape', rect, wantsKeyboard),
  focus: () => ipcRenderer.send('island:focus'),
  blur: () => ipcRenderer.send('island:blur'),
  showMain: () => ipcRenderer.send('island:show-main'),
  openDocument: (path, page, terms) => ipcRenderer.invoke('duct:openDocument', path, page, terms),
  addFiles: (files) => ipcRenderer.invoke('island:add-files', files.map(f => webUtils.getPathForFile(f)).filter(Boolean)),
  onPointer: (callback) => ipcRenderer.on('island:pointer', (_event, inside) => callback(inside)),
  onOpenSearch: (callback) => ipcRenderer.on('island:open-search', () => callback()),
  onSettings: (callback) => ipcRenderer.on('island:settings', (_event, settings) => callback(settings)),
})
