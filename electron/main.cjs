const { app, BrowserWindow, Menu, Tray, dialog, nativeImage, shell, Notification, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const { pathToFileURL } = require('url')

let mainWindow = null
let tray = null
let duct = null
let server = null
let serverUrl = ''
let library = null

// One running copy only: a second launch focuses the existing window instead of opening the same index twice.
// Overrides for tests and portable installs.
if (process.env.DUCT_USER_DATA_DIR) app.setPath('userData', process.env.DUCT_USER_DATA_DIR)

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

function libraryDir() {
  return process.env.DUCT_LIBRARY_DIR || path.join(app.getPath('home'), 'Duct Library')
}

async function createDuct() {
  const { Duct } = await import('../dist/index.js')
  library = await import('../dist/library.js')
  duct = new Duct({
    persistPath: path.join(app.getPath('userData'), 'data'),
    search: { rerank: true },
  })
  return duct
}

async function startServer() {
  const { createServer } = await import('../dist/server.js')
  const expressApp = createServer(duct, { uploadLimitMb: 100, libraryDir: libraryDir() })
  return new Promise((resolve) => {
    server = expressApp.listen(0, '127.0.0.1', () => {
      serverUrl = `http://127.0.0.1:${server.address().port}`
      resolve(serverUrl)
    })
  })
}

// Asks the page to refresh its counts, document list and mascot after background changes.
function refreshPage() {
  mainWindow?.webContents.executeJavaScript('typeof showIdleMascot === "function" && (showIdleMascot(), refreshDocs())').catch(() => {})
}

function notify(body) {
  new Notification({ title: 'Duct', body }).show()
}

// Copies files into ~/Duct Library and indexes the copies (duplicates are skipped).
async function addFilesToLibrary(filePaths) {
  let added = 0
  let duplicates = 0
  for (const file of filePaths) {
    const r = await library.addToLibrary(duct, libraryDir(), file)
    if (r.duplicateOf) duplicates++
    else added += r.documents
  }
  refreshPage()
  return { added, duplicates }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Duct',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, 'icon.png'),
    show: false,
    backgroundColor: '#0C0C0B',
  })

  // Links opened from the page (e.g. indexed web pages) go to the system browser, never a bare Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !url.startsWith(serverUrl)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(serverUrl)) event.preventDefault()
  })

  mainWindow.loadURL(serverUrl)

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.on('close', (e) => {
    if (app.getLoginItemSettings().wasOpenedAtLogin) {
      e.preventDefault()
      mainWindow.hide()
    }
  })
}

function createAppMenu() {
  const template = [
    {
      label: 'Duct',
      submenu: [
        {
          label: 'About Duct',
          role: 'about',
        },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'Cmd+,',
          click: () => mainWindow?.webContents.executeJavaScript(
            `document.getElementById('settings')?.scrollIntoView({behavior:'smooth'})`
          ),
        },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'Cmd+Q', click: () => app.quit() },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'Add Files to Library…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              properties: ['openFile', 'multiSelections'],
              filters: [
                { name: 'Documents', extensions: ['pdf', 'docx', 'md', 'txt', 'html', 'csv', 'json', 'log', 'xml', 'xlsx', 'pptx'] },
                { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'tiff', 'tif', 'bmp', 'gif', 'webp'] },
              ],
            })
            if (result.canceled || result.filePaths.length === 0) return
            try {
              const { added, duplicates } = await addFilesToLibrary(result.filePaths)
              notify(`Added ${added} file(s) to your Duct Library` + (duplicates ? `, skipped ${duplicates} already indexed` : ''))
            } catch (err) {
              dialog.showErrorBox('Could not add files', err.message)
            }
          },
        },
        {
          label: 'Watch Folder…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
            if (result.canceled || result.filePaths.length === 0) return
            try {
              await duct.watch([result.filePaths[0]], refreshPage)
              refreshPage()
              notify(`Watching ${result.filePaths[0]}`)
            } catch (err) {
              dialog.showErrorBox('Could not watch folder', err.message)
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Export Search Results…',
          accelerator: 'Cmd+E',
          click: () => mainWindow?.webContents.executeJavaScript(
            `document.querySelector('[onclick*="exportResults"]')?.click()`
          ),
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', role: 'undo' },
        { label: 'Redo', role: 'redo' },
        { type: 'separator' },
        { label: 'Cut', role: 'cut' },
        { label: 'Copy', role: 'copy' },
        { label: 'Paste', role: 'paste' },
        { label: 'Select All', role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'Cmd+R', role: 'reload' },
        { label: 'Toggle DevTools', accelerator: 'Cmd+Alt+I', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'Cmd+=', role: 'zoomIn' },
        { label: 'Zoom Out', accelerator: 'Cmd+-', role: 'zoomOut' },
        { label: 'Reset Zoom', accelerator: 'Cmd+0', role: 'resetZoom' },
        { type: 'separator' },
        { label: 'Toggle Full Screen', accelerator: 'Cmd+Ctrl+F', role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { label: 'Minimize', accelerator: 'Cmd+M', role: 'minimize' },
        { label: 'Close', accelerator: 'Cmd+W', role: 'close' },
        { type: 'separator' },
        { label: 'Bring All to Front', role: 'front' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Documentation',
          click: () => shell.openExternal('https://github.com/docfide/duct'),
        },
        {
          label: 'Report Issue',
          click: () => shell.openExternal('https://github.com/docfide/duct/issues'),
        },
      ],
    },
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

function createTray() {
  try {
    // trayTemplate.png is a macOS template image (recoloured for light/dark menu bars);
    // Electron picks up the @2x variant next to each file automatically.
    const iconName = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'
    const iconPath = path.join(__dirname, 'icons', iconName)
    tray = new Tray(fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty())
    tray.setToolTip('Duct')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show Duct', click: () => { mainWindow?.show(); mainWindow?.focus() } },
      { label: 'Quit', click: () => app.quit() },
    ]))
    tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus() })
  } catch {}
}

ipcMain.handle('dialog:openDirectory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('dialog:openFiles', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'All Supported', extensions: ['pdf', 'docx', 'md', 'txt', 'html', 'csv', 'json', 'log', 'xml', 'xlsx', 'pptx', 'png', 'jpg', 'jpeg', 'tiff', 'tif', 'bmp', 'gif', 'webp'] },
    ],
  })
  return result.canceled ? null : result.filePaths
})

// The page asks to watch a folder; the user picks it here, so the HTTP API never accepts arbitrary paths.
ipcMain.handle('duct:watchDirectory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
  if (result.canceled || result.filePaths.length === 0) return null
  const dir = result.filePaths[0]
  await duct.watch([dir], refreshPage)
  return dir
})

// Only documents in the index can be opened or revealed; the page can't name arbitrary paths.
function indexedFile(filePath) {
  const doc = typeof filePath === 'string' ? duct.getDocument(filePath) : undefined
  if (!doc || doc.source === 'url' || !fs.existsSync(doc.path)) return null
  return doc
}

ipcMain.handle('duct:openDocument', async (_event, filePath, page) => {
  const doc = indexedFile(filePath)
  if (!doc) return false
  if (path.extname(doc.path).toLowerCase() === '.pdf') {
    // Chromium's built-in PDF viewer jumps to #page=N.
    const viewer = new BrowserWindow({
      width: 1000,
      height: 1100,
      title: doc.displayName || path.basename(doc.path),
      backgroundColor: '#0C0C0B',
      webPreferences: { plugins: true, contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    const pageNumber = Number.isInteger(page) && page > 0 ? page : 1
    await viewer.loadURL(`${pathToFileURL(doc.path).href}#page=${pageNumber}`)
    return true
  }
  const error = await shell.openPath(doc.path)
  return error === ''
})

ipcMain.handle('duct:revealDocument', (_event, filePath) => {
  const doc = indexedFile(filePath)
  if (!doc) return false
  shell.showItemInFolder(doc.path)
  return true
})

ipcMain.handle('notification:show', (_event, title, body) => {
  new Notification({ title, body }).show()
})

ipcMain.handle('app:version', () => app.getVersion())

app.whenReady().then(async () => {
  if (!gotLock) return
  await createDuct()
  const url = await startServer()
  console.log(`  Server started at ${url}`)

  createAppMenu()
  createWindow()
  createTray()

  // Catch up on watched folders (files added, changed or deleted while Duct was closed), then keep watching.
  duct.restoreSources(refreshPage).then(refreshPage).catch(err => console.error('Could not restore watched folders:', err))
  // Safety net for missed file events (network drives, sleep/wake): recheck watched folders every 30 minutes.
  setInterval(() => {
    duct?.rescanSources().then(refreshPage).catch(err => console.error('Rescan failed:', err))
  }, 30 * 60 * 1000).unref()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (mainWindow === null) createWindow()
  else mainWindow.show()
})

// The index is kept between launches; quitting only stops watchers and closes the database.
app.on('before-quit', () => {
  if (tray) tray.destroy()
  if (server) server.close()
  if (duct) {
    try { duct.close() } catch {}
    duct = null
  }
})
