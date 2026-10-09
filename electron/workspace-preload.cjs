// The workspace window's only bridge to the desktop app: open the document it shows in the app it belongs to.
// The main process checks the path is an indexed document before opening anything.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ductWorkspace', {
  openInApp: path => ipcRenderer.invoke('duct:openInApp', path),
})
